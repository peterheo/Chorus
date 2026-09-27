import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../helpers/fixture.ts';
import { makeWorld, newTask, requestReviewAs, taskInReview, type World } from '../helpers/world.ts';
import { isChorusError, roomPulse, type Uuid } from '../../src/index.ts';

describe('roomPulse (real PostgreSQL, chorus_app read context)', () => {
  let f: Fixture;
  let w: World;

  beforeAll(async () => {
    f = await createFixture();
    w = await makeWorld(f, await f.workspace('pulse'));
  });

  afterAll(async () => {
    await f.close();
  });

  const seedNonTask = async (kind: 'question' | 'proposal', title: string) => {
    const [row] = await f.owner<{ id: Uuid }>(
      `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title,
                               state, creator_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7) RETURNING id`,
      [w.ws.id, w.session.id, w.session.boardId, kind, w.session.roomId, title, w.manager.id],
    );
    if (row === undefined) throw new Error('expected inserted item');
    return row.id;
  };

  it('returns session scoped counts and ordered, de-duplicated actions with role-gated claim actions', async () => {
    const blocked = await newTask(w);
    await f.owner(
      `UPDATE work_items SET state = 'in_progress', owner_actor_id = $2,
                              blocked_reason = 'waiting', blocked_at = now() - interval '2 hours'
        WHERE id = $1`,
      [blocked.id, w.reviewer.id],
    );
    await f.owner(
      `UPDATE task_leases SET instance_id = $2, expires_at = now() - interval '1 hour'
        WHERE task_id = $1`,
      [blocked.id, w.reviewer.instanceId],
    );

    const staleLease = await newTask(w);
    await f.owner(
      `UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1`,
      [staleLease.id, w.reviewer.id],
    );
    await f.owner(
      `UPDATE task_leases SET instance_id = $2, expires_at = now() - interval '30 minutes'
        WHERE task_id = $1`,
      [staleLease.id, w.reviewer.instanceId],
    );

    const noLease = await newTask(w);
    await f.owner(
      `UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1`,
      [noLease.id, w.reviewer.id],
    );

    const liveLease = await newTask(w);
    await f.owner(
      `UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1`,
      [liveLease.id, w.reviewer.id],
    );
    await f.owner(
      `UPDATE task_leases SET instance_id = $2, expires_at = now() + interval '1 hour'
        WHERE task_id = $1`,
      [liveLease.id, w.reviewer.instanceId],
    );

    const ready = await newTask(w);
    await f.owner('UPDATE work_items SET priority = 0 WHERE id = $1', [ready.id]);
    const claimTask = await newTask(w);
    await f.owner("UPDATE work_items SET state = 'review' WHERE id = $1", [claimTask.id]);
    await f.owner(
      `INSERT INTO claim_requests (workspace_id, session_id, task_id, requester_actor_id)
       VALUES ($1, $2, $3, $4)`,
      [w.ws.id, w.session.id, claimTask.id, w.executor.id],
    );

    const inReview = await taskInReview(w);
    const requestedReview = await requestReviewAs(
      w,
      inReview.taskId,
      inReview.version,
      inReview.revision,
      w.reviewer,
    );
    const staleReviewTask = await taskInReview(w);
    await requestReviewAs(
      w,
      staleReviewTask.taskId,
      staleReviewTask.version,
      staleReviewTask.revision,
      w.reviewer,
    );
    await f.owner(
      `INSERT INTO task_result_revisions (workspace_id, session_id, task_id, revision, content,
                                          byte_length, content_sha256, submitted_by, fence)
       VALUES ($1, $2, $3, 2, 'new revision', 12,
               encode(digest(convert_to('new revision', 'UTF8'), 'sha256'), 'hex'), $4, 1)`,
      [w.ws.id, w.session.id, staleReviewTask.taskId, w.executor.id],
    );
    const cancelledReviewTask = await taskInReview(w);
    const cancelledReview = await requestReviewAs(
      w,
      cancelledReviewTask.taskId,
      cancelledReviewTask.version,
      cancelledReviewTask.revision,
      w.reviewer,
    );
    await f.owner(
      `UPDATE review_details SET cancelled_at = now(), cancel_reason = 'test cancellation'
        WHERE review_item_id = $1`,
      [cancelledReview.review.id],
    );
    const question = await seedNonTask('question', 'Old question');
    const proposal = await seedNonTask('proposal', 'Proposal');
    await f.owner(`UPDATE work_items SET created_at = now() - interval '25 hours' WHERE id = $1`, [
      question,
    ]);
    await f.owner(
      `INSERT INTO message_links (workspace_id, session_id, item_id, sharednet_message_id,
                                 sharednet_sequence, sender_principal_id, sender_member_id,
                                 content_snapshot, content_sha256, linked_by)
       VALUES ($1, $2, $3, 'msg-pulse', 1, 'principal-pulse', 'member-pulse', 'linked', $4, $5)`,
      [w.ws.id, w.session.id, ready.id, 'a'.repeat(64), w.manager.id],
    );

    const before = await f.owner<{ commands: string; events: string; versions: string }>(
      `SELECT (SELECT count(*) FROM commands WHERE session_id = $1)::text AS commands,
              (SELECT count(*) FROM domain_events WHERE session_id = $1)::text AS events,
              (SELECT coalesce(sum(version), 0) FROM work_items WHERE session_id = $1)::text AS versions`,
      [w.session.id],
    );
    const memberPulse = await roomPulse(f.readCtx(w.reviewer), {});
    const managerPulse = await roomPulse(f.readCtx(w.manager), { session_id: w.session.id });
    const repeated = await roomPulse(f.readCtx(w.reviewer), {});
    const after = await f.owner<{ commands: string; events: string; versions: string }>(
      `SELECT (SELECT count(*) FROM commands WHERE session_id = $1)::text AS commands,
              (SELECT count(*) FROM domain_events WHERE session_id = $1)::text AS events,
              (SELECT coalesce(sum(version), 0) FROM work_items WHERE session_id = $1)::text AS versions`,
      [w.session.id],
    );

    const member = memberPulse.sessions[0];
    const manager = managerPulse.sessions[0];
    if (member === undefined || manager === undefined) throw new Error('expected session pulse');
    expect(memberPulse.coverage).toBe('chorus_state_only');
    expect(Number.isNaN(Date.parse(memberPulse.generated_at))).toBe(false);
    expect(member.session_id).toBe(w.session.id);
    expect(member.name.startsWith('session')).toBe(true);
    expect(member.counts).toMatchObject({
      ready_unowned: 1,
      in_progress: 4,
      blocked: 1,
      stale_leases: 3,
      pending_reviews: 1,
      stale_reviews: 1,
      open_questions: 1,
      open_proposals: 1,
      pending_claim_requests: 1,
      linked_messages: 1,
    });
    expect(member.next_actions.slice(0, 5).map(({ kind, item_id }) => [kind, item_id])).toEqual([
      ['blocked_task', blocked.id],
      ['review_assigned', requestedReview.review.id],
      ['stale_lease', noLease.id],
      ['stale_lease', staleLease.id],
      ['ready_task', ready.id],
    ]);
    expect(member.next_actions[0]?.reason).toBe('You own this task and it is blocked.');
    expect(member.next_actions[1]?.reason).toBe(
      'A review of the latest result is assigned to you.',
    );
    expect(member.next_actions[2]?.reason).toBe('Your lease expired; claim again to continue.');
    expect(member.next_actions.some((action) => action.kind === 'claim_request')).toBe(false);
    expect(manager.counts.pending_claim_requests).toBe(1);
    expect(manager.next_actions).toContainEqual(
      expect.objectContaining({ kind: 'claim_request', item_id: claimTask.id }),
    );
    expect(Date.parse(repeated.generated_at)).toBeGreaterThanOrEqual(
      Date.parse(memberPulse.generated_at),
    );
    expect(repeated.sessions).toEqual(memberPulse.sessions);
    expect(after).toEqual(before);
    expect(member.next_actions.filter((action) => action.item_id === blocked.id)).toHaveLength(1);
    expect(question).toBeTruthy();
    expect(proposal).toBeTruthy();
  });

  it('filters to one live session and conceals unknown or non-member sessions', async () => {
    const only = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
    expect(only.sessions).toHaveLength(1);
    await expect(
      roomPulse(f.readCtx(w.reviewer), { session_id: 'bad-id' as Uuid }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { field: 'session_id' },
    });
    await expect(
      roomPulse(f.readCtx(w.reviewer), {
        session_id: '00000000-0000-7000-8000-000000000001' as Uuid,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      roomPulse(f.readCtx(w.outsider), { session_id: w.session.id }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    const error = await roomPulse(f.readCtx(w.outsider), {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error === undefined || isChorusError(error, 'not_found')).toBe(true);
  });

  it('caps each session at ten actions', async () => {
    for (let index = 0; index < 12; index++) {
      const task = await newTask(w);
      await f.owner(
        `UPDATE work_items SET owner_actor_id = $2, blocked_reason = 'waiting', blocked_at = now()
          WHERE id = $1`,
        [task.id, w.reviewer.id],
      );
    }
    const pulse = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
    const session = pulse.sessions[0];
    if (session === undefined) throw new Error('expected session pulse');
    expect(session.next_actions).toHaveLength(10);
    expect(session.next_actions.every((action) => action.kind === 'blocked_task')).toBe(true);
  });

  it('returns at most 50 sessions in created_at and id order', async () => {
    for (let index = 0; index < 51; index++) {
      await f.session(w.manager, { name: `pulse-cap-${String(index)}` });
    }
    const expected = await f.owner<{ id: Uuid }>(
      `SELECT id FROM sessions WHERE workspace_id = $1 AND created_by = $2
        ORDER BY created_at ASC, id ASC LIMIT 50`,
      [w.ws.id, w.manager.id],
    );
    const pulse = await roomPulse(f.readCtx(w.manager), {});
    expect(pulse.sessions.map((session) => session.session_id)).toEqual(
      expected.map((row) => row.id),
    );
  });

  it('excludes a member after session removal or room removal', async () => {
    const sessionRemoved = await w.participant('pulse-session-removed');
    const roomRemoved = await w.participant('pulse-room-removed');
    await f.owner(
      `UPDATE session_members SET removed_at = now()
        WHERE workspace_id = $1 AND session_id = $2 AND actor_id = $3`,
      [w.ws.id, w.session.id, sessionRemoved.id],
    );
    await f.owner(
      `UPDATE room_members SET removed_at = now()
        WHERE workspace_id = $1 AND room_id = $2 AND actor_id = $3`,
      [w.ws.id, w.session.roomId, roomRemoved.id],
    );
    expect((await roomPulse(f.readCtx(sessionRemoved), {})).sessions).toEqual([]);
    expect((await roomPulse(f.readCtx(roomRemoved), {})).sessions).toEqual([]);
    await expect(
      roomPulse(f.readCtx(sessionRemoved), { session_id: w.session.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      roomPulse(f.readCtx(roomRemoved), { session_id: w.session.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
