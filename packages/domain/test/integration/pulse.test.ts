import { describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../helpers/fixture.ts';
import { makeWorld, newTask, requestReviewAs, taskInReview, type World } from '../helpers/world.ts';
import { createTask, removeMember, roomPulse, type Uuid } from '../../src/index.ts';

interface CountScenario {
  readonly blockedReady: Uuid;
  readonly ownerReady: Uuid;
  readonly staleReview: Uuid;
  readonly cancelledReview: Uuid;
}

describe('roomPulse (real PostgreSQL, chorus_app read context)', () => {
  it('PQ1 pulse.counts', async () => {
    await withWorld('pulse-counts', async (f, w) => {
      const scenario = await seedCountScenario(f, w);
      const pulse = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
      const session = requiredSession(pulse.sessions[0]);
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
      expect(actionIds).not.toContain(scenario.ownerReady);
      expect(actionIds).not.toContain(scenario.blockedReady);
      expect(actionIds).not.toContain(scenario.staleReview);
      expect(actionIds).not.toContain(scenario.cancelledReview);
    });
  });

  it('PQ2 pulse.actions.order_and_cap', async () => {
    await withWorld('pulse-actions', async (f, w) => {
      const blocked = await newTask(w);
      await setBlocked(f, blocked.id as Uuid, w.manager.id, 'in_progress');
      await f.owner(
        `UPDATE task_leases SET instance_id = $2, expires_at = now() - interval '1 hour'
          WHERE task_id = $1`,
        [blocked.id, w.manager.instanceId],
      );

      const reviewTask = await taskInReview(w);
      const requestedReview = await requestReviewAs(
        w,
        reviewTask.taskId,
        reviewTask.version,
        reviewTask.revision,
        w.manager,
      );

      const noLease = await newTask(w);
      await f.owner(
        `UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1`,
        [noLease.id, w.manager.id],
      );
      const staleLease = await newTask(w);
      await f.owner(
        `UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1`,
        [staleLease.id, w.manager.id],
      );
      await f.owner(
        `UPDATE task_leases SET instance_id = $2, expires_at = now() - interval '30 minutes'
          WHERE task_id = $1`,
        [staleLease.id, w.manager.instanceId],
      );

      const createdAt = '2000-01-01T00:00:00Z';
      const readyTasks: Array<{ id: Uuid; priority: number; createdAt: string }> = [];
      for (const priority of [0, 1, 1, 2, 3, 4]) {
        const task = await newTask(w);
        readyTasks.push({ id: task.id as Uuid, priority, createdAt });
        await f.owner(`UPDATE work_items SET priority = $2, created_at = $3 WHERE id = $1`, [
          task.id,
          priority,
          createdAt,
        ]);
      }
      const orderedReady = [...readyTasks].sort(
        (a, b) =>
          a.priority - b.priority ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );

      const claimTask = await newTask(w);
      await f.owner("UPDATE work_items SET state = 'review' WHERE id = $1", [claimTask.id]);
      await f.owner(
        `INSERT INTO claim_requests (workspace_id, session_id, task_id, requester_actor_id)
         VALUES ($1, $2, $3, $4)`,
        [w.ws.id, w.session.id, claimTask.id, w.executor.id],
      );
      const question = await seedWorkItem(f, w, 'question', 'Old question');
      await f.owner(
        `UPDATE work_items SET created_at = now() - interval '25 hours' WHERE id = $1`,
        [question],
      );

      const pulse = await roomPulse(f.readCtx(w.manager), { session_id: w.session.id });
      const actions = requiredSession(pulse.sessions[0]).next_actions;
      const expected: Array<[string, Uuid]> = [
        ['blocked_task', blocked.id as Uuid],
        ['review_assigned', requestedReview.review.id as Uuid],
        ['stale_lease', noLease.id as Uuid],
        ['stale_lease', staleLease.id as Uuid],
        ...orderedReady.map(({ id }) => ['ready_task', id] as [string, Uuid]),
      ];
      expect(
        new Set([
          blocked.id,
          requestedReview.review.id,
          noLease.id,
          staleLease.id,
          ...readyTasks.map(({ id }) => id),
          claimTask.id,
          question,
        ]).size,
      ).toBe(12);
      expect(actions.map(({ kind, item_id }) => [kind, item_id])).toEqual(expected);
      expect(actions).toHaveLength(10);
      expect(actions.filter((action) => action.item_id === blocked.id)).toHaveLength(1);
      expect(actions[0]?.reason).toBe('You own this task and it is blocked.');
      expect(actions[1]?.reason).toBe('A review of the latest result is assigned to you.');
      expect(actions[2]?.reason).toBe('Your lease expired; claim again to continue.');
      expect(actions[6]?.reason).toBe('Ready and unowned.');
    });
  });

  it('PQ3 pulse.claim_request_role', async () => {
    await withWorld('pulse-claims', async (f, w) => {
      const claimTask = await newTask(w);
      await f.owner("UPDATE work_items SET state = 'review' WHERE id = $1", [claimTask.id]);
      await f.owner(
        `INSERT INTO claim_requests (workspace_id, session_id, task_id, requester_actor_id)
         VALUES ($1, $2, $3, $4)`,
        [w.ws.id, w.session.id, claimTask.id, w.executor.id],
      );
      const member = requiredSession(
        (await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id })).sessions[0],
      );
      const manager = requiredSession(
        (await roomPulse(f.readCtx(w.manager), { session_id: w.session.id })).sessions[0],
      );
      expect(member.counts.pending_claim_requests).toBe(1);
      expect(member.next_actions.some((action) => action.kind === 'claim_request')).toBe(false);
      const action = manager.next_actions.find((item) => item.kind === 'claim_request');
      if (action === undefined) throw new Error('expected manager claim action');
      expect(action.item_id).toBe(claimTask.id);
      expect(action.reason).toBe('A claim request awaits a manager decision.');
    });
  });

  it('PQ4 pulse.read_only', async () => {
    await withWorld('pulse-read-only', async (f, w) => {
      await newTask(w);
      const before = await mutationSnapshot(f, w.session.id);
      await roomPulse(f.readCtx(w.reviewer), {});
      await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
      await roomPulse(f.readCtx(w.manager), { session_id: w.session.id });
      expect(await mutationSnapshot(f, w.session.id)).toEqual(before);
    });
  });

  it('PQ5 pulse.isolation', async () => {
    await withWorld('pulse-isolation', async (f, w) => {
      const sessionB = await f.session(w.manager, { name: 'pulse-session-B' });
      const { task } = await createTask(w.manager.ctx(), {
        session_id: sessionB.id,
        board_id: sessionB.boardId,
        title: 'only in session B',
        body: '',
        acceptance_criteria: ['criterion'],
        shareable: false,
      });
      const memberAOnly = await roomPulse(f.readCtx(w.executor), {});
      expect(memberAOnly.sessions).toHaveLength(1);
      expect(memberAOnly.sessions.map((session) => session.session_id)).toEqual([w.session.id]);
      expect(JSON.stringify(memberAOnly)).not.toContain(sessionB.id);
      expect(JSON.stringify(memberAOnly)).not.toContain(task.id);

      const deniedB = await rejectionDetails(
        roomPulse(f.readCtx(w.executor), { session_id: sessionB.id }),
      );
      const deniedUnknown = await rejectionDetails(
        roomPulse(f.readCtx(w.executor), {
          session_id: '00000000-0000-7000-8000-000000000001' as Uuid,
        }),
      );
      expect(deniedB).toEqual({ code: 'not_found', message: 'Not found.' });
      expect(deniedUnknown).toEqual(deniedB);
    });
  });

  it('PQ6 pulse.session_filter', async () => {
    await withWorld('pulse-session-filter', async (f, w) => {
      const sessionB = await f.session(w.manager, { name: 'pulse-filter-B' });
      await f.join(sessionB, w.reviewer);
      const all = await roomPulse(f.readCtx(w.reviewer), {});
      expect(all.sessions.map((session) => session.session_id)).toContain(sessionB.id);
      const filtered = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
      expect(filtered.sessions.map((session) => session.session_id)).toEqual([w.session.id]);
      await expect(
        roomPulse(f.readCtx(w.reviewer), { session_id: 'bad-id' as Uuid }),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { field: 'session_id' },
      });
    });
  });

  it('PQ7 pulse.shape', async () => {
    await withWorld('pulse-shape', async (f, w) => {
      await seedActionScenario(f, w);
      for (let index = 0; index < 50; index++) {
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
      expect(Object.keys(listed).sort()).toEqual(['coverage', 'generated_at', 'sessions']);
      expect(listed.coverage).toBe('chorus_state_only');
      expect(new Date(listed.generated_at).toISOString()).toBe(listed.generated_at);

      const memberPulse = await roomPulse(f.readCtx(w.reviewer), { session_id: w.session.id });
      const member = requiredSession(memberPulse.sessions[0]);
      expect(Object.keys(member).sort()).toEqual(['counts', 'name', 'next_actions', 'session_id']);
      expect(Object.keys(member.counts).sort()).toEqual([
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
      expect(member.next_actions.map((action) => action.reason)).toEqual([
        'You own this task and it is blocked.',
        'A review of the latest result is assigned to you.',
        'Your lease expired; claim again to continue.',
        'Your lease expired; claim again to continue.',
        'Ready and unowned.',
        'Open for more than 24 hours.',
      ]);
      const manager = requiredSession(
        (await roomPulse(f.readCtx(w.manager), { session_id: w.session.id })).sessions[0],
      );
      expect(manager.next_actions.map((action) => action.reason)).toEqual([
        'Ready and unowned.',
        'A claim request awaits a manager decision.',
        'Open for more than 24 hours.',
      ]);
    });
  });

  it('PQ8 pulse.removed_member', async () => {
    await withWorld('pulse-removed-member', async (f, w) => {
      const sessionRemoved = await w.participant('pulse-session-removed');
      const roomRemoved = await w.participant('pulse-room-removed');
      await removeMember(w.manager.ctx(), {
        session_id: w.session.id,
        actor_id: sessionRemoved.id,
      });
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
      ).rejects.toMatchObject({
        code: 'not_found',
      });
    });
  });
});

async function withWorld(
  name: string,
  test: (fixture: Fixture, world: World) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture();
  try {
    const world = await makeWorld(fixture, await fixture.workspace(name), { managerReview: true });
    await test(fixture, world);
  } finally {
    await fixture.close();
  }
}

async function seedCountScenario(f: Fixture, w: World): Promise<CountScenario> {
  const blocked = await newTask(w);
  await setBlocked(f, blocked.id as Uuid, w.reviewer.id, 'in_progress');
  await f.owner(
    `UPDATE task_leases SET instance_id = $2, expires_at = now() - interval '1 hour'
      WHERE task_id = $1`,
    [blocked.id, w.reviewer.instanceId],
  );
  const stale = await newTask(w);
  await f.owner("UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1", [
    stale.id,
    w.reviewer.id,
  ]);
  await f.owner(
    `UPDATE task_leases SET instance_id = $2, expires_at = now() - interval '30 minutes'
      WHERE task_id = $1`,
    [stale.id, w.reviewer.instanceId],
  );
  const noLease = await newTask(w);
  await f.owner("UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1", [
    noLease.id,
    w.reviewer.id,
  ]);
  const liveLease = await newTask(w);
  await f.owner("UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1", [
    liveLease.id,
    w.reviewer.id,
  ]);
  await f.owner(
    `UPDATE task_leases SET instance_id = $2, expires_at = now() + interval '1 hour'
      WHERE task_id = $1`,
    [liveLease.id, w.reviewer.instanceId],
  );
  const doneBlocked = await newTask(w);
  await setBlocked(f, doneBlocked.id as Uuid, w.reviewer.id, 'done');

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
  await requestReviewAs(
    w,
    currentTask.taskId,
    currentTask.version,
    currentTask.revision,
    w.reviewer,
  );
  const staleTask = await taskInReview(w);
  const staleReview = await requestReviewAs(
    w,
    staleTask.taskId,
    staleTask.version,
    staleTask.revision,
    w.reviewer,
  );
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

  const question = await seedWorkItem(f, w, 'question', 'Old question');
  await f.owner(`UPDATE work_items SET created_at = now() - interval '25 hours' WHERE id = $1`, [
    question,
  ]);
  await seedWorkItem(f, w, 'question', 'Closed question', 'closed');
  await seedWorkItem(f, w, 'proposal', 'Open proposal');
  await seedWorkItem(f, w, 'proposal', 'Withdrawn proposal', 'withdrawn');
  await f.owner(
    `INSERT INTO message_links (workspace_id, session_id, item_id, sharednet_message_id,
                               sharednet_sequence, sender_principal_id, sender_member_id,
                               content_snapshot, content_sha256, linked_by)
     VALUES ($1, $2, $3, 'msg-pulse', 1, 'principal-pulse', 'member-pulse', 'linked', $4, $5)`,
    [w.ws.id, w.session.id, ready.id, 'a'.repeat(64), w.manager.id],
  );
  return {
    blockedReady: blockedReady.id as Uuid,
    ownerReady: ownerReady.id as Uuid,
    staleReview: staleReview.review.id as Uuid,
    cancelledReview: cancelledReview.review.id as Uuid,
  };
}

async function seedActionScenario(f: Fixture, w: World): Promise<void> {
  const blocked = await newTask(w);
  await setBlocked(f, blocked.id as Uuid, w.reviewer.id, 'in_progress');
  await f.owner(
    `UPDATE task_leases SET instance_id = $2, expires_at = now() - interval '1 hour'
      WHERE task_id = $1`,
    [blocked.id, w.reviewer.instanceId],
  );
  const reviewTask = await taskInReview(w);
  await requestReviewAs(w, reviewTask.taskId, reviewTask.version, reviewTask.revision, w.reviewer);
  const noLease = await newTask(w);
  await f.owner("UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1", [
    noLease.id,
    w.reviewer.id,
  ]);
  const staleLease = await newTask(w);
  await f.owner("UPDATE work_items SET state = 'in_progress', owner_actor_id = $2 WHERE id = $1", [
    staleLease.id,
    w.reviewer.id,
  ]);
  await f.owner(
    `UPDATE task_leases SET instance_id = $2, expires_at = now() - interval '30 minutes'
      WHERE task_id = $1`,
    [staleLease.id, w.reviewer.instanceId],
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
  const question = await seedWorkItem(f, w, 'question', 'Old question');
  await f.owner(`UPDATE work_items SET created_at = now() - interval '25 hours' WHERE id = $1`, [
    question,
  ]);
}

async function setBlocked(
  f: Fixture,
  taskId: Uuid,
  ownerId: Uuid,
  state: 'ready' | 'in_progress' | 'done',
): Promise<void> {
  await f.owner(
    `UPDATE work_items SET state = $2, owner_actor_id = $3, blocked_reason = 'waiting',
                            blocked_at = now() - interval '2 hours'
      WHERE id = $1`,
    [taskId, state, ownerId],
  );
}

async function seedWorkItem(
  f: Fixture,
  w: World,
  kind: 'question' | 'proposal',
  title: string,
  state: 'open' | 'closed' | 'withdrawn' = 'open',
): Promise<Uuid> {
  const [row] = await f.owner<{ id: Uuid }>(
    `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title,
                             state, creator_actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [w.ws.id, w.session.id, w.session.boardId, kind, w.session.roomId, title, state, w.manager.id],
  );
  if (row === undefined) throw new Error('expected inserted item');
  return row.id;
}

function requiredSession<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected session pulse');
  return value;
}

async function mutationSnapshot(f: Fixture, sessionId: Uuid) {
  const [row] = await f.owner<{ commands: string; events: string; versions: string }>(
    `SELECT (SELECT count(*) FROM commands WHERE session_id = $1)::text AS commands,
            (SELECT count(*) FROM domain_events WHERE session_id = $1)::text AS events,
            (SELECT coalesce(sum(version), 0) FROM work_items WHERE session_id = $1)::text AS versions`,
    [sessionId],
  );
  if (row === undefined) throw new Error('expected mutation snapshot');
  return row;
}

async function rejectionDetails(
  promise: Promise<unknown>,
): Promise<{ code: unknown; message: unknown }> {
  const error = await promise.then(
    () => {
      throw new Error('expected the query to reject');
    },
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error)) throw new Error('expected an Error rejection');
  return { code: (error as Error & { code?: unknown }).code, message: error.message };
}
