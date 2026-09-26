import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBoard,
  createSession,
  createTask,
  getSession,
  getTask,
  grantRole,
  isChorusError,
  joinSession,
  leaveSession,
  listBoards,
  listMembers,
  listSessions,
  listWork,
  removeMember,
  revokeRole,
  setSessionPolicy,
  type ChorusError,
  type ErrorCode,
} from '../../src/index.ts';
import { createFixture, type Actor, type Fixture, type Workspace } from '../helpers/fixture.ts';
import {
  claimAs,
  makeWorld,
  newTask,
  requestReviewAs,
  uniqueKey,
  taskInReview,
} from '../helpers/world.ts';

async function failure(promise: Promise<unknown>): Promise<ChorusError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the command to reject');
    },
    (e: unknown) => e,
  );
  if (!isChorusError(error)) throw error as Error;
  return error;
}
async function expectCode(promise: Promise<unknown>, code: ErrorCode, reason?: string) {
  const error = await failure(promise);
  expect(error.code).toBe(code);
  if (reason !== undefined) expect(error.details['reason']).toBe(reason);
  return error;
}

describe('sessions (real PostgreSQL, as chorus_app)', () => {
  let f: Fixture;
  let ws: Workspace;

  beforeAll(async () => {
    f = await createFixture({ poolMax: 24 });
    ws = await f.workspace('sess');
  });
  afterAll(async () => {
    await f.close();
  });

  const rctx = (a: Actor) => ({ ...f.readCtx(a), roomId: a.ws.roomId });
  const newSession = (a: Actor, over: Record<string, unknown> = {}) =>
    createSession(a.ctx(uniqueKey('cs')), { name: 'S', board_name: 'B', ...over });

  it('create_session and join_session: creator is participant+manager+administrator with board 1; joiners are participants', async () => {
    const creator = await f.actor(ws, 'creator');
    const joiner = await f.actor(ws, 'joiner');
    const created = await newSession(creator, { name: 'Alpha', board_name: 'First board' });
    expect(created).toMatchObject({
      session: {
        room_id: ws.roomId,
        name: 'Alpha',
        version: 2,
        join_policy: 'open',
        discoverable: true,
      },
      board: { name: 'First board' },
      membership: { actor_id: creator.id, roles: ['participant', 'manager', 'administrator'] },
    });
    const events = await f.owner<{ event_type: string; aggregate_version: number }>(
      `SELECT event_type, aggregate_version FROM domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [created.session.id],
    );
    expect(events.map((e) => [e.event_type, e.aggregate_version])).toEqual([
      ['session.created', 1],
      ['board.created', 2],
    ]);

    const sid = created.session.id;
    const joined = await joinSession(joiner.ctx('join-1'), { session_id: sid });
    expect(joined).toEqual({ session_id: sid, roles: ['participant'], joined: true });
    // Joining again is an idempotent no-op that changes nothing.
    const again = await joinSession(joiner.ctx('join-2'), { session_id: sid });
    expect(again).toEqual({ session_id: sid, roles: ['participant'], joined: false });
    expect(
      await f.count(
        `SELECT count(*) AS n FROM domain_events WHERE aggregate_id = $1 AND event_type = 'session.member_joined'`,
        [sid],
      ),
    ).toBe(1);
    expect(
      (await listMembers(f.readCtx(joiner), { session_id: sid })).items.map((m) => [
        m.actor_id,
        m.roles,
      ]),
    ).toEqual([
      [creator.id, ['participant', 'manager', 'administrator']],
      [joiner.id, ['participant']],
    ]);
    // A verified room member sees and lists it; a non-room-member does nothing.
    expect((await listSessions(rctx(joiner), {})).items).toEqual([
      expect.objectContaining({ id: sid, member: true, roles: ['participant'] }),
    ]);
    const stranger = await f.actor(ws, 'not-in-room', { inRoom: false });
    await expectCode(newSession(stranger), 'not_found');
    await expectCode(joinSession(stranger.ctx(), { session_id: sid }), 'not_found');
    // Any participant can create tasks in the new session.
    const board = (await listBoards(f.readCtx(joiner), { session_id: sid })).items[0];
    const task = await createTask(joiner.ctx(), {
      session_id: sid,
      board_id: board?.id,
      title: 'first task',
      acceptance_criteria: ['done'],
    });
    expect(task.task.session_id).toBe(sid);
  });

  it('create_session.concurrency: a concurrent same-key create yields one session and one board', async () => {
    const creator = await f.actor(ws, 'racer');
    const key = uniqueKey('race');
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        createSession(creator.ctx(key), { name: 'Raced', board_name: 'B' }),
      ),
    );
    expect(new Set(results.map((r) => r.session.id)).size).toBe(1);
    expect(
      await f.count(`SELECT count(*) AS n FROM sessions WHERE created_by = $1`, [creator.id]),
    ).toBe(1);
    expect(
      await f.count(`SELECT count(*) AS n FROM projects WHERE session_id = $1`, [
        results[0]?.session.id,
      ]),
    ).toBe(1);
    // Different keys make different sessions.
    const other = await newSession(creator);
    expect(other.session.id).not.toBe(results[0]?.session.id);
  });

  it('sessions.isolation.disjoint: two sessions in one room share nothing', async () => {
    const wa = await makeWorld(f, ws);
    const wb = await makeWorld(f, ws);
    // Populate A completely: task, result, review, and a private session.
    const t = await taskInReview(wa);
    const r = await requestReviewAs(wa, t.taskId, t.version, 1);
    const hidden = await newSession(wa.manager, { name: 'private', discoverable: false });

    // Every read and command of B's members against A's ids is not_found.
    const probes: (() => Promise<unknown>)[] = [
      () => getTask(f.readCtx(wb.executor), { session_id: wa.session.id, task_id: t.taskId }),
      () => getTask(f.readCtx(wb.executor), { session_id: wb.session.id, task_id: t.taskId }),
      () => listWork(f.readCtx(wb.executor), { session_id: wa.session.id }),
      () => getSession(f.readCtx(wb.executor), { session_id: wa.session.id }),
      () => listMembers(f.readCtx(wb.executor), { session_id: wa.session.id }),
      () => listBoards(f.readCtx(wb.executor), { session_id: wa.session.id }),
      () => claimAs(wb, t.taskId, t.version),
      () => requestReviewAs(wa, t.taskId, r.task_version, 1, wb.reviewer, wb.executor),
      () => createBoard(wb.manager.ctx(), { session_id: wa.session.id, name: 'x' }),
      () =>
        setSessionPolicy(wb.manager.ctx(), {
          session_id: wa.session.id,
          expected_version: 2,
          name: 'stolen',
        }),
      () =>
        grantRole(wb.manager.ctx(), {
          session_id: wa.session.id,
          actor_id: wb.manager.id,
          role: 'administrator',
        }),
      () => removeMember(wb.manager.ctx(), { session_id: wa.session.id, actor_id: wa.executor.id }),
    ];
    for (const [i, probe] of probes.entries()) {
      const error = await failure(probe());
      expect(error.code, `probe ${String(i)}`).toBe('not_found');
    }
    // Directly through RLS: B's members see none of A's rows in any session-scoped table.
    for (const table of [
      'work_items',
      'task_details',
      'task_leases',
      'task_result_revisions',
      'review_details',
      'task_criteria_revisions',
      'projects',
      'session_members',
      'domain_events',
    ]) {
      const ownRows = await f.count(`SELECT count(*) AS n FROM ${table} WHERE session_id = $1`, [
        wb.session.id,
      ]);
      expect(
        ownRows +
          (await f.count(`SELECT count(*) AS n FROM ${table} WHERE session_id = $1`, [
            wa.session.id,
          ])),
        table,
      ).toBeGreaterThan(0);
      const client = await f.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
          [ws.id, wb.executor.id],
        );
        const seenA = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table} WHERE session_id = $1`,
          [wa.session.id],
        );
        expect(Number(seenA.rows[0]?.n), `${table}: B must see none of A`).toBe(0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
    // A non-discoverable session is never listed or counted for a non-member.
    const listed = await listSessions(rctx(wb.executor), {});
    expect(listed.items.map((s) => s.id)).not.toContain(hidden.session.id);
    expect(listed.items.map((s) => s.id)).toEqual(
      expect.arrayContaining([wa.session.id, wb.session.id]),
    );
    const insideHidden = await listSessions(rctx(wa.manager), {});
    expect(insideHidden.items.map((s) => s.id)).toContain(hidden.session.id);
    await expectCode(
      joinSession(wb.executor.ctx(), { session_id: hidden.session.id }),
      'not_found',
    );
  });

  it('sessions.roles.overlap: the same actor holds different roles in different sessions, evaluated independently', async () => {
    const wa = await makeWorld(f, ws);
    const wb = await makeWorld(f, ws);
    const dual = await f.actor(ws, 'dual');
    await f.join(wa.session, dual, ['participant', 'manager']);
    await f.join(wb.session, dual, ['participant']);
    const a = await newTask(wa, { reviewRequired: false });
    await claimAs(wa, a.id as never, a.version);
    // As manager in A the dual actor may create a board; as a participant in B it may not.
    await expect(
      createBoard(dual.ctx(), { session_id: wa.session.id, name: 'ok' }),
    ).resolves.toBeDefined();
    await expectCode(
      createBoard(dual.ctx(), { session_id: wb.session.id, name: 'no' }),
      'action_forbidden',
      'role',
    );
    // Same for completion: A's manager may complete (once the gates pass); B's participant may not.
    const doneA = await taskInReview(wa, { reviewRequired: false });
    await expect(
      (await import('../../src/index.ts')).completeTask(dual.ctx(), {
        session_id: wa.session.id,
        task_id: doneA.taskId,
        expected_version: doneA.version,
      }),
    ).resolves.toMatchObject({ state: 'done' });
    const inB = await taskInReview(wb, { reviewRequired: false });
    await expectCode(
      (await import('../../src/index.ts')).completeTask(dual.ctx(), {
        session_id: wb.session.id,
        task_id: inB.taskId,
        expected_version: inB.version,
      }),
      'action_forbidden',
    );
  });

  it('sessions.revocation: removal (session or room) and role revocation block fresh calls AND replays', async () => {
    const w = await makeWorld(f, ws);
    const victim = await w.participant('victim');
    const doIt = (key: string) =>
      createTask(victim.ctx(key), {
        session_id: w.session.id,
        board_id: w.session.boardId,
        title: 'v',
        acceptance_criteria: ['c'],
      });
    const first = await doIt('rev-1');
    // Administrator removes the member through the domain command.
    await removeMember(w.manager.ctx(), { session_id: w.session.id, actor_id: victim.id });
    await expectCode(doIt('rev-2'), 'not_found');
    await expectCode(doIt('rev-1'), 'not_found'); // replay: no stored body
    expect(JSON.stringify(await failure(doIt('rev-1')))).not.toContain(first.task.id);
    // Room removal: a live session member who leaves the ROOM loses every session at once (RLS).
    const other = await w.participant('roomless');
    await createTask(other.ctx('room-1'), {
      session_id: w.session.id,
      board_id: w.session.boardId,
      title: 'v',
      acceptance_criteria: ['c'],
    });
    await f.owner('UPDATE room_members SET removed_at = now() WHERE actor_id = $1', [other.id]);
    await expectCode(
      createTask(other.ctx('room-2'), {
        session_id: w.session.id,
        board_id: w.session.boardId,
        title: 'v',
        acceptance_criteria: ['c'],
      }),
      'not_found',
    );
    await expectCode(
      createTask(other.ctx('room-1'), {
        session_id: w.session.id,
        board_id: w.session.boardId,
        title: 'v',
        acceptance_criteria: ['c'],
      }),
      'not_found',
    );
    await expectCode(getSession(f.readCtx(other), { session_id: w.session.id }), 'not_found');
    // Deactivating the room closes it for everyone.
    await f.owner(`UPDATE rooms SET activation_state = 'suspended' WHERE id = $1`, [ws.roomId]);
    try {
      await expectCode(
        createTask(w.executor.ctx('susp-1'), {
          session_id: w.session.id,
          board_id: w.session.boardId,
          title: 'v',
          acceptance_criteria: ['c'],
        }),
        'not_found',
      );
    } finally {
      await f.owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [ws.roomId]);
    }
    // Role revocation: a manager loses manager actions, on fresh calls and replays.
    const mgr = await w.participant('mgr');
    await grantRole(w.manager.ctx(), {
      session_id: w.session.id,
      actor_id: mgr.id,
      role: 'manager',
    });
    const board = () => createBoard(mgr.ctx('board-key'), { session_id: w.session.id, name: 'B2' });
    await board();
    await revokeRole(w.manager.ctx(), {
      session_id: w.session.id,
      actor_id: mgr.id,
      role: 'manager',
    });
    await expectCode(board(), 'action_forbidden');
    await expectCode(
      createBoard(mgr.ctx('board-key-2'), { session_id: w.session.id, name: 'B3' }),
      'action_forbidden',
    );
  });

  it("matrix.enforced: administrator without manager and manager without administrator are each denied the other's actions", async () => {
    const w = await makeWorld(f, ws);
    const adminOnly = await f.actor(ws, 'admin-only');
    const managerOnly = await f.actor(ws, 'manager-only');
    await f.join(w.session, adminOnly, ['participant', 'administrator']);
    await f.join(w.session, managerOnly, ['participant', 'manager']);
    // Manager-only actions.
    await expectCode(
      createBoard(adminOnly.ctx(), { session_id: w.session.id, name: 'x' }),
      'action_forbidden',
    );
    await expect(
      createBoard(managerOnly.ctx(), { session_id: w.session.id, name: 'x' }),
    ).resolves.toBeDefined();
    const t = await taskInReview(w, { reviewRequired: false });
    const complete = (a: Actor) =>
      import('../../src/index.ts').then(({ completeTask }) =>
        completeTask(a.ctx(), {
          session_id: w.session.id,
          task_id: t.taskId,
          expected_version: t.version,
        }),
      );
    await expectCode(complete(adminOnly), 'action_forbidden');
    await expect(complete(managerOnly)).resolves.toMatchObject({ state: 'done' });
    // Administrator-only actions.
    const target = await w.participant('target');
    for (const attempt of [
      (a: Actor) =>
        setSessionPolicy(a.ctx(), {
          session_id: w.session.id,
          expected_version: 2,
          discoverable: true,
        }),
      (a: Actor) =>
        grantRole(a.ctx(), { session_id: w.session.id, actor_id: target.id, role: 'manager' }),
      (a: Actor) => removeMember(a.ctx(), { session_id: w.session.id, actor_id: target.id }),
    ]) {
      await expectCode(attempt(managerOnly), 'action_forbidden');
    }
    await expect(
      grantRole(adminOnly.ctx(), {
        session_id: w.session.id,
        actor_id: target.id,
        role: 'manager',
      }),
    ).resolves.toMatchObject({ roles: ['participant', 'manager'] });
    // A plain participant has none of them.
    await expectCode(
      grantRole(w.executor.ctx(), {
        session_id: w.session.id,
        actor_id: target.id,
        role: 'administrator',
      }),
      'action_forbidden',
    );
    await expectCode(
      createBoard(w.executor.ctx(), { session_id: w.session.id, name: 'x' }),
      'action_forbidden',
    );
  });

  it('join.policies: open, listed and unsupported policies; a removed member rejoins as participant only', async () => {
    const owner = await f.actor(ws, 'policy-owner');
    const listedActor = await f.actor(ws, 'listed');
    const other = await f.actor(ws, 'other');
    await f.owner(
      `INSERT INTO external_identities (workspace_id, actor_id, provider, principal_id) VALUES ($1, $2, 'sharednet', 'p_ListedPrincipal1')`,
      [ws.id, listedActor.id],
    );
    const listed = await newSession(owner, {
      name: 'Listed',
      join_policy: 'listed',
      listed_principals: ['p_ListedPrincipal1'],
    });
    await expectCode(joinSession(other.ctx(), { session_id: listed.session.id }), 'not_found');
    await expect(
      joinSession(listedActor.ctx(), { session_id: listed.session.id }),
    ).resolves.toMatchObject({ joined: true });

    // Not-yet-supported policies are refused loudly, never treated as open.
    for (const bad of [
      { join_policy: 'policy_matched' },
      { join_policy: 'session_credential' },
      { default_claim_policy: 'manager_assigned' },
      { default_claim_policy: 'approval_required' },
    ]) {
      await expectCode(newSession(owner, bad), 'invalid_request', 'not_supported_yet');
    }
    await expectCode(
      joinSession(other.ctx(), { session_id: listed.session.id, join_credential: 'csj_x' }),
      'invalid_request',
      'not_supported_yet',
    );

    // Open + non-discoverable is not joinable by knowing the id.
    const hiddenOpen = await newSession(owner, { name: 'Hidden', discoverable: false });
    await expectCode(joinSession(other.ctx(), { session_id: hiddenOpen.session.id }), 'not_found');

    // A removed member is re-evaluated by the policy on rejoin and gets participant only.
    const open = await newSession(owner, { name: 'Open' });
    await joinSession(other.ctx('j1'), { session_id: open.session.id });
    await grantRole(owner.ctx(), {
      session_id: open.session.id,
      actor_id: other.id,
      role: 'manager',
    });
    await removeMember(owner.ctx(), { session_id: open.session.id, actor_id: other.id });
    const rejoined = await joinSession(other.ctx('j2'), { session_id: open.session.id });
    expect(rejoined).toEqual({ session_id: open.session.id, roles: ['participant'], joined: true });
  });

  it('administration: policy changes are version-checked; the last administrator cannot leave or be demoted', async () => {
    const admin = await f.actor(ws, 'admin');
    const s = await newSession(admin, { name: 'Admin' });
    const sid = s.session.id;
    const changed = await setSessionPolicy(admin.ctx(), {
      session_id: sid,
      expected_version: 2,
      name: 'Renamed',
      manager_review_allowed: true,
    });
    expect(changed).toMatchObject({ version: 3, changed: ['name', 'manager_review_allowed'] });
    await expectCode(
      setSessionPolicy(admin.ctx(), { session_id: sid, expected_version: 2, name: 'Stale' }),
      'version_conflict',
    );
    await expectCode(
      setSessionPolicy(admin.ctx(), { session_id: sid, expected_version: 3 }),
      'invalid_request',
    );
    expect(await getSession(f.readCtx(admin), { session_id: sid })).toMatchObject({
      name: 'Renamed',
      version: 3,
      manager_review_allowed: true,
      my_roles: ['participant', 'manager', 'administrator'],
    });

    // Granting and revoking are idempotent no-ops when nothing changes.
    const other = await f.actor(ws, 'second-admin');
    await joinSession(other.ctx(), { session_id: sid });
    await expect(
      grantRole(admin.ctx(), { session_id: sid, actor_id: other.id, role: 'administrator' }),
    ).resolves.toMatchObject({ roles: ['participant', 'administrator'] });
    const again = await grantRole(admin.ctx(), {
      session_id: sid,
      actor_id: other.id,
      role: 'administrator',
    });
    expect(again.roles).toEqual(['participant', 'administrator']);
    // The last administrator cannot be demoted, removed, or leave.
    await revokeRole(admin.ctx(), { session_id: sid, actor_id: other.id, role: 'administrator' });
    await expectCode(
      revokeRole(admin.ctx(), { session_id: sid, actor_id: admin.id, role: 'administrator' }),
      'invalid_transition',
      'last_administrator',
    );
    await expectCode(
      leaveSession(admin.ctx(), { session_id: sid }),
      'invalid_transition',
      'last_administrator',
    );
    await expectCode(
      removeMember(admin.ctx(), { session_id: sid, actor_id: admin.id }),
      'invalid_transition',
      'last_administrator',
    );
    // Anyone else may leave; after leaving they see nothing.
    await expect(leaveSession(other.ctx(), { session_id: sid })).resolves.toMatchObject({
      actor_id: other.id,
    });
    await expectCode(getSession(f.readCtx(other), { session_id: sid }), 'not_found');
  });

  it('remove_member.effects: pending reviews are cancelled, leases cleared (owner kept), all in one transaction', async () => {
    const w = await makeWorld(f, ws);
    // The reviewer holds a pending review; the executor holds a live lease on another task.
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1, w.reviewer);
    const leased = await newTask(w);
    const claimed = await claimAs(w, leased.id as never, leased.version);

    await removeMember(w.manager.ctx(), { session_id: w.session.id, actor_id: w.reviewer.id });
    const [review] = await f.owner<{
      state: string;
      cancelled: boolean;
      reason: string;
      version: number;
    }>(
      `SELECT w.state, d.cancelled_at IS NOT NULL AS cancelled, d.cancel_reason AS reason, w.version
         FROM work_items w JOIN review_details d ON d.review_item_id = w.id WHERE w.id = $1`,
      [r.review.id],
    );
    expect(review).toMatchObject({
      state: 'cancelled',
      cancelled: true,
      reason: 'reviewer_removed',
      version: 2,
    });
    // The cancelled review no longer counts, so the revision can be reviewed by someone else.
    await expect(
      requestReviewAs(w, t.taskId, r.task_version, 1, w.reviewer2),
    ).resolves.toMatchObject({ review: { revision: 1 } });

    await removeMember(w.manager.ctx(), { session_id: w.session.id, actor_id: w.executor.id });
    const [lease] = await f.owner<{ instance_id: string | null; live: boolean; fence: string }>(
      `SELECT instance_id, COALESCE(expires_at > now(), false) AS live, fence FROM task_leases WHERE task_id = $1`,
      [leased.id],
    );
    expect(lease).toEqual({ instance_id: null, live: false, fence: String(claimed.fence) });
    const [task] = await f.owner<{ owner_actor_id: string; version: number }>(
      'SELECT owner_actor_id, version FROM work_items WHERE id = $1',
      [leased.id],
    );
    expect(task).toEqual({ owner_actor_id: w.executor.id, version: claimed.version + 1 });
    // Every changed aggregate got exactly one event at its new version.
    const ev = await f.owner<{ event_type: string }>(
      `SELECT event_type FROM domain_events WHERE aggregate_id = ANY($1::uuid[]) AND aggregate_version >= 2 ORDER BY event_type`,
      [[r.review.id, leased.id]],
    );
    expect(ev.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(['review.cancelled', 'task.lease_cleared']),
    );
  });
});
