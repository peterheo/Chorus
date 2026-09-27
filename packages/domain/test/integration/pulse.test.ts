import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture, type SessionSeed } from '../helpers/fixture.ts';
import { makeWorld, newTask, requestReviewAs, taskInReview, type World } from '../helpers/world.ts';
import { createTask, roomPulse, type Uuid } from '../../src/index.ts';

interface PulseSeed {
  readonly blocked: Uuid;
  readonly noLease: Uuid;
  readonly staleLease: Uuid;
  readonly ready: Uuid;
  readonly claimTask: Uuid;
  readonly currentReview: Uuid;
  readonly question: Uuid;
  readonly ownerReady: Uuid;
  readonly blockedReady: Uuid;
}

describe('roomPulse (real PostgreSQL, chorus_app read context)', () => {
  let f: Fixture;
  let w: World;
  let seed: PulseSeed;
  let actionCapSession: SessionSeed;
  let isolationSession: SessionSeed;

  beforeAll(async () => {
    f = await createFixture();
    w = await makeWorld(f, await f.workspace('pulse'));

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
    const blockedReady = await newTask(w);
    await f.owner(
      `UPDATE work_items SET blocked_reason = 'waiting', blocked_at = now() WHERE id = $1`,
      [blockedReady.id],
    );
    const ownerReady = await newTask(w);
    await f.owner('UPDATE work_items SET owner_actor_id = $2 WHERE id = $1', [
      ownerReady.id,
      w.reviewer.id,
    ]);
    const claimTask = await newTask(w);
    await f.owner("UPDATE work_items SET state = 'review' WHERE id = $1", [claimTask.id]);
    await f.owner(
      `INSERT INTO claim_requests (workspace_id, session_id, task_id, requester_actor_id)
       VALUES ($1, $2, $3, $4)`,
      [w.ws.id, w.session.id, claimTask.id, w.executor.id],
    );

    const currentTask = await taskInReview(w);
    const currentReview = await requestReviewAs(
      w,
      currentTask.taskId,
      currentTask.version,
      currentTask.revision,
      w.reviewer,
    );
    const staleTask = await taskInReview(w);
    await requestReviewAs(w, staleTask.taskId, staleTask.version, staleTask.revision, w.reviewer);
    await f.owner(
      `INSERT INTO task_result_revisions (workspace_id, session_id, task_id, revision, content,
                                          byte_length, content_sha256, submitted_by, fence)
       VALUES ($1, $2, $3, 2, 'new revision', 12,
               encode(digest(convert_to('new revision', 'UTF8'), 'sha256'), 'hex'), $4, 1)`,
      [w.ws.id, w.session.id, staleTask.taskId, w.executor.id],
    );
    const cancelledTask = await taskInReview(w);
    const cancelledReview = await requestReviewAs(
      w,
      cancelledTask.taskId,
      cancelledTask.version,
      cancelledTask.revision,
      w.reviewer,
    );
    await f.owner(
      `UPDATE review_details SET cancelled_at = now(), cancel_reason = 'test cancellation'
        WHERE review_item_id = $1`,
      [cancelledReview.review.id],
    );

    const question = await seedNonTask(f, w, 'question', 'Old question');
    await seedNonTask(f, w, 'proposal', 'Proposal');
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

    seed = {
      blocked: blocked.id as Uuid,
      noLease: noLease.id as Uuid,
      staleLease: staleLease.id as Uuid,
      ready: ready.id as Uuid,
      claimTask: claimTask.id as Uuid,
      currentReview: currentReview.review.id as Uuid,
      question,
      ownerReady: ownerReady.id as Uuid,
      blockedReady: blockedReady.id as Uuid,
    };
  });

  afterAll(async () => {
    await f.close();
  });

  it('PQ1: counts current state and excludes cancelled reviews while retaining near-miss semantics', async () => {
    const pulse = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
    const session = pulse.sessions[0];
    if (session === undefined) throw new Error('expected session pulse');
    expect(session.counts).toEqual({
      ready_unowned: 2,
      in_progress: 4,
      blocked: 2,
      stale_leases: 3,
      pending_reviews: 1,
      stale_reviews: 1,
      open_questions: 1,
      open_proposals: 1,
      pending_claim_requests: 1,
      linked_messages: 1,
    });
    const actionIds = session.next_actions.map((action) => action.item_id);
    expect(actionIds).not.toContain(seed.ownerReady);
    expect(actionIds).not.toContain(seed.blockedReady);
    expect(seed.ownerReady).not.toBe(seed.ready);
    expect(seed.blockedReady).not.toBe(seed.ready);
  });

  it('PQ2: orders actions by rule, deduplicates earlier rules, and caps at ten', async () => {
    actionCapSession = await f.session(w.manager, { name: 'pulse-action-cap' });
    const blockedIds: Uuid[] = [];
    for (let index = 0; index < 12; index++) {
      const { task } = await createTask(w.manager.ctx(), {
        session_id: actionCapSession.id,
        board_id: actionCapSession.boardId,
        title: `cap task ${String(index)}`,
        body: '',
        acceptance_criteria: ['criterion'],
        shareable: false,
      });
      blockedIds.push(task.id as Uuid);
      await f.owner(
        `UPDATE work_items SET state = $2, owner_actor_id = $3,
                                blocked_reason = 'waiting', blocked_at = now()
          WHERE id = $1`,
        [task.id, index === 0 ? 'in_progress' : 'ready', w.manager.id],
      );
    }
    const expected = await f.owner<{ id: Uuid }>(
      `SELECT id FROM work_items WHERE session_id = $1 AND kind = 'task'
          AND owner_actor_id = $2 AND blocked_reason IS NOT NULL
          AND state NOT IN ('done', 'cancelled')
        ORDER BY blocked_at ASC, id ASC LIMIT 10`,
      [actionCapSession.id, w.manager.id],
    );
    const pulse = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
    const session = pulse.sessions[0];
    if (session === undefined) throw new Error('expected session pulse');
    expect(session.next_actions.slice(0, 6).map(({ kind, item_id }) => [kind, item_id])).toEqual([
      ['blocked_task', seed.blocked],
      ['review_assigned', seed.currentReview],
      ['stale_lease', seed.noLease],
      ['stale_lease', seed.staleLease],
      ['ready_task', seed.ready],
      ['open_question', seed.question],
    ]);
    const capped = await roomPulse(f.readCtx(w.manager), { session_id: actionCapSession.id });
    const cappedActions = capped.sessions[0]?.next_actions ?? [];
    expect(cappedActions).toHaveLength(10);
    expect(cappedActions.map((action) => action.item_id)).toEqual(expected.map((row) => row.id));
    expect(cappedActions.every((action) => action.kind === 'blocked_task')).toBe(true);
    expect(cappedActions.some((action) => action.item_id === blockedIds[0])).toBe(true);
    expect(cappedActions.filter((action) => action.item_id === blockedIds[0])).toHaveLength(1);
  });

  it('PQ3: shows claim counts to members but claim actions only to managers', async () => {
    const memberPulse = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
    const managerPulse = await roomPulse(f.readCtx(w.manager), { session_id: w.session.id });
    expect(memberPulse.sessions[0]?.counts.pending_claim_requests).toBe(1);
    expect(
      memberPulse.sessions[0]?.next_actions.some((action) => action.kind === 'claim_request'),
    ).toBe(false);
    const manager = managerPulse.sessions[0];
    if (manager === undefined) throw new Error('expected manager pulse');
    expect(manager.counts.pending_claim_requests).toBe(1);
    const claimAction = manager.next_actions.find((action) => action.kind === 'claim_request');
    if (claimAction === undefined) throw new Error('expected manager claim action');
    expect(claimAction.kind).toBe('claim_request');
    expect(claimAction.item_id).toBe(seed.claimTask);
    expect(typeof claimAction.title).toBe('string');
    expect(claimAction.reason).toBe('A claim request awaits a manager decision.');
  });

  it('PQ4: three pulse calls do not change commands, events, or work item versions', async () => {
    const before = await mutationSnapshot(f, w.session.id);
    await roomPulse(f.readCtx(w.reviewer), {});
    await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
    await roomPulse(f.readCtx(w.manager), { session_id: w.session.id });
    const after = await mutationSnapshot(f, w.session.id);
    expect(after).toEqual(before);
  });

  it('PQ5: keeps same-room sessions isolated and conceals cross-session or unknown sessions', async () => {
    isolationSession = await f.session(w.manager, { name: 'pulse-isolation' });
    await f.join(isolationSession, w.reviewer);
    await createTask(w.manager.ctx(), {
      session_id: isolationSession.id,
      board_id: isolationSession.boardId,
      title: 'only in second session',
      body: '',
      acceptance_criteria: ['criterion'],
      shareable: false,
    });
    const pulse = await roomPulse(f.readCtx(w.reviewer), {});
    const original = pulse.sessions.find((session) => session.session_id === w.session.id);
    const isolated = pulse.sessions.find((session) => session.session_id === isolationSession.id);
    expect(pulse.sessions.map((session) => session.session_id)).toContain(w.session.id);
    expect(original?.counts.ready_unowned).toBe(2);
    expect(isolated?.counts.ready_unowned).toBe(1);
    await expect(
      roomPulse(f.readCtx(w.executor), { session_id: isolationSession.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      roomPulse(f.readCtx(w.reviewer), {
        session_id: '00000000-0000-7000-8000-000000000001' as Uuid,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('PQ6: selects exactly one session and reports malformed session ids', async () => {
    const pulse = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
    expect(pulse.sessions.map((session) => session.session_id)).toEqual([w.session.id]);
    await expect(
      roomPulse(f.readCtx(w.reviewer), { session_id: 'bad-id' as Uuid }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { field: 'session_id' },
    });
  });

  it('PQ7: returns the stable shape, exact reasons, ISO timestamp, and 50-session limit', async () => {
    for (let index = 0; index < 51; index++) {
      await f.session(w.manager, { name: `pulse-list-${String(index)}` });
    }
    const expected = await f.owner<{ id: Uuid }>(
      `SELECT id FROM sessions WHERE workspace_id = $1 AND created_by = $2
        ORDER BY created_at ASC, id ASC LIMIT 50`,
      [w.ws.id, w.manager.id],
    );
    const listed = await roomPulse(f.readCtx(w.manager), {});
    expect(listed.sessions).toHaveLength(50);
    expect(listed.sessions.map((session) => session.session_id)).toEqual(
      expected.map((row) => row.id),
    );
    expect(listed.coverage).toBe('chorus_state_only');
    expect(new Date(listed.generated_at).toISOString()).toBe(listed.generated_at);

    const memberPulse = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
    const session = memberPulse.sessions[0];
    if (session === undefined) throw new Error('expected session pulse');
    expect(Object.keys(session).sort()).toEqual(['counts', 'name', 'next_actions', 'session_id']);
    expect(Object.keys(session.counts).sort()).toEqual([
      'blocked',
      'in_progress',
      'linked_messages',
      'open_proposals',
      'open_questions',
      'pending_claim_requests',
      'pending_reviews',
      'ready_unowned',
      'stale_leases',
      'stale_reviews',
    ]);
    expect(session.next_actions.map((action) => action.reason)).toEqual([
      'You own this task and it is blocked.',
      'A review of the latest result is assigned to you.',
      'Your lease expired; claim again to continue.',
      'Your lease expired; claim again to continue.',
      'Ready and unowned.',
      'Open for more than 24 hours.',
    ]);
    const managerPulse = await roomPulse(f.readCtx(w.manager), { session_id: w.session.id });
    expect(managerPulse.sessions[0]?.next_actions.map((action) => action.reason)).toContain(
      'A claim request awaits a manager decision.',
    );
  });

  it('PQ8: excludes members after session removal and room removal', async () => {
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

async function seedNonTask(
  fixture: Fixture,
  world: World,
  kind: 'question' | 'proposal',
  title: string,
): Promise<Uuid> {
  const [row] = await fixture.owner<{ id: Uuid }>(
    `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title,
                             state, creator_actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7) RETURNING id`,
    [
      world.ws.id,
      world.session.id,
      world.session.boardId,
      kind,
      world.session.roomId,
      title,
      world.manager.id,
    ],
  );
  if (row === undefined) throw new Error('expected inserted item');
  return row.id;
}

async function mutationSnapshot(fixture: Fixture, sessionId: Uuid) {
  const [row] = await fixture.owner<{ commands: string; events: string; versions: string }>(
    `SELECT (SELECT count(*) FROM commands WHERE session_id = $1)::text AS commands,
            (SELECT count(*) FROM domain_events WHERE session_id = $1)::text AS events,
            (SELECT coalesce(sum(version), 0) FROM work_items WHERE session_id = $1)::text AS versions`,
    [sessionId],
  );
  if (row === undefined) throw new Error('expected mutation snapshot');
  return row;
}
