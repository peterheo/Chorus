import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  completeTask,
  createSession,
  grantRole,
  isChorusError,
  joinSession,
  leaveSession,
  removeMember,
  requestReview,
  revokeRole,
  reviewVerdict,
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
  submitAs,
  taskInReview,
  uniqueKey,
  verdictAs,
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

/** Amendment A4.3: the P1 review round (room-aware liveness, lock-then-authorize, definer-only writes). */
describe('A4.3 review round (real PostgreSQL, as chorus_app)', () => {
  let f: Fixture;
  let ws: Workspace;

  beforeAll(async () => {
    f = await createFixture({ poolMax: 14 });
    ws = await f.workspace('a43');
  });
  afterAll(async () => {
    await f.close();
  });

  const removeFromRoom = (a: Actor) =>
    f.owner(
      `UPDATE room_members SET removed_at = now() WHERE workspace_id = $1 AND room_id = $2 AND actor_id = $3`,
      [a.ws.id, a.ws.roomId, a.id],
    );
  const version = async (sessionId: string) =>
    Number(
      (
        await f.owner<{ version: number }>('SELECT version FROM sessions WHERE id = $1', [
          sessionId,
        ])
      )[0]?.version,
    );

  it('B1: a room-removed co-administrator does not count toward the last-administrator guard', async () => {
    const w = await makeWorld(f, ws);
    const b = await w.participant('co-admin');
    await grantRole(w.manager.ctx(), {
      session_id: w.session.id,
      actor_id: b.id,
      role: 'administrator',
    });
    await removeFromRoom(b);
    await expectCode(
      revokeRole(w.manager.ctx(), {
        session_id: w.session.id,
        actor_id: w.manager.id,
        role: 'administrator',
      }),
      'invalid_transition',
      'last_administrator',
    );
    // The same predicate rules out removal and leaving.
    await expectCode(
      leaveSession(w.manager.ctx(), { session_id: w.session.id }),
      'invalid_transition',
      'last_administrator',
    );
  });

  it('B1: grant_role to a room-removed member is not_found; a room-removed reviewer is not eligible', async () => {
    const w = await makeWorld(f, ws);
    const gone = await w.participant('gone');
    await removeFromRoom(gone);
    await expectCode(
      grantRole(w.manager.ctx(), { session_id: w.session.id, actor_id: gone.id, role: 'manager' }),
      'not_found',
    );
    const t = await taskInReview(w);
    await expectCode(
      requestReviewAs(w, t.taskId, t.version, t.revision, gone),
      'invalid_request',
      'reviewer_not_eligible',
    );
    // An administrator can still close the membership of someone who already left the room.
    await removeMember(w.manager.ctx(), { session_id: w.session.id, actor_id: gone.id });
  });

  it('B2: a command that waited on the session lock authorizes with the roles current after it', async () => {
    const w = await makeWorld(f, ws);
    const b = await w.participant('second-admin');
    const target = await w.participant('target');
    await grantRole(w.manager.ctx(), {
      session_id: w.session.id,
      actor_id: b.id,
      role: 'administrator',
    });
    // Hold the session row as if A's command were still running, then revoke B's role inside it.
    const { Client } = await import('pg');
    const owner = new Client({ connectionString: f.db.url });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE', [w.session.id]);
      const blocked = failure(
        grantRole(b.ctx(), { session_id: w.session.id, actor_id: target.id, role: 'manager' }),
      );
      // Wait until B's command is really parked on the lock.
      for (let i = 0; i < 100; i++) {
        const n = await f.count(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%chorus_session_lock%'`,
        );
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      await owner.query(
        `UPDATE session_members SET roles = ARRAY['participant'] WHERE session_id = $1 AND actor_id = $2`,
        [w.session.id, b.id],
      );
      await owner.query('COMMIT');
      const error = await blocked;
      expect(error.code).toBe('action_forbidden');
    } finally {
      await owner.end();
    }
  });

  it('B3: manager-review eligibility is re-checked at verdict time and recorded on the review', async () => {
    const w = await makeWorld(f, ws, { managerReview: false });
    const r = await w.participant('later-manager');
    const t = await taskInReview(w);
    const req = await requestReviewAs(w, t.taskId, t.version, t.revision, r);
    await grantRole(w.manager.ctx(), { session_id: w.session.id, actor_id: r.id, role: 'manager' });
    await expectCode(
      verdictAs(w, req.review, t.digest, 'approved', r),
      'action_forbidden',
      'reviewer_not_eligible',
    );
    await setSessionPolicy(w.manager.ctx(), {
      session_id: w.session.id,
      expected_version: await version(w.session.id),
      manager_review_allowed: true,
    });
    const done = await verdictAs(w, req.review, t.digest, 'approved', r);
    expect(done.task.state).toBe('done');
    const [row] = await f.owner<{ verdict_reviewer_roles: string[] }>(
      'SELECT verdict_reviewer_roles FROM review_details WHERE review_item_id = $1',
      [req.review.id],
    );
    expect(row?.verdict_reviewer_roles).toEqual(['participant', 'manager']);
  });

  it('B4: a review cannot reference a task in another session, even for the table owner', async () => {
    const wa = await makeWorld(f, ws);
    const wb = await makeWorld(f, ws);
    const t = await taskInReview(wa);
    const req = await requestReviewAs(wa, t.taskId, t.version, t.revision);
    // Same revision and digest as the real subject, so only the session-bound FK can reject it.
    const other = await taskInReview(wb);
    await expect(
      f.owner(`UPDATE review_details SET subject_task_id = $2 WHERE review_item_id = $1`, [
        req.review.id,
        other.taskId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('B5: chorus_app cannot UPDATE session_members or sessions directly (42501)', async () => {
    const w = await makeWorld(f, ws);
    const client = await f.pool.connect();
    const attempt = async (sql: string) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
          [ws.id, w.executor.id],
        );
        await client.query(sql, [w.session.id]);
      } finally {
        await client.query('ROLLBACK');
      }
    };
    try {
      await expect(
        attempt(
          `UPDATE session_members SET roles = ARRAY['participant','manager','administrator'] WHERE session_id = $1`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        attempt(`UPDATE sessions SET join_policy = 'listed' WHERE id = $1`),
      ).rejects.toMatchObject({ code: '42501' });
      // The definers re-verify the caller's current role, so a participant cannot use them either.
      await expect(
        attempt(
          `SELECT chorus_session_set_roles($1, '${w.executor.id}', ARRAY['participant','administrator'])`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        attempt(`SELECT chorus_session_set_policy($1, '{"join_policy":"listed"}'::jsonb)`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
    const [row] = await f.owner<{ roles: string[] }>(
      'SELECT roles FROM session_members WHERE session_id = $1 AND actor_id = $2',
      [w.session.id, w.executor.id],
    );
    expect(row?.roles).toEqual(['participant']);
  });

  it('B6: create_session replay is not_found, with no body, once the creator is no longer a member', async () => {
    const creator = await f.actor(ws, 'replayer');
    const admin = await f.actor(ws, 'other-admin');
    const key = uniqueKey('cs');
    const created = await createSession(creator.ctx(key), { name: 'R', board_name: 'B' });
    await joinSession(admin.ctx(), { session_id: created.session.id });
    await grantRole(creator.ctx(), {
      session_id: created.session.id,
      actor_id: admin.id,
      role: 'administrator',
    });
    expect(await createSession(creator.ctx(key), { name: 'R', board_name: 'B' })).toEqual(created);
    await removeMember(admin.ctx(), { session_id: created.session.id, actor_id: creator.id });
    await expectCode(createSession(creator.ctx(key), { name: 'R', board_name: 'B' }), 'not_found');
  });

  it('B7: identity/separation (403) outranks version (409) and lifecycle (422)', async () => {
    const w = await makeWorld(f, ws, { managerReview: true });
    // The manager owns the task, so naming them as reviewer is a separation error.
    const task = await newTask(w, { by: w.manager });
    const claimed = await claimAs(w, task.id as never, task.version, w.manager);
    await expectCode(
      requestReview(w.manager.ctx(), {
        session_id: w.session.id,
        task_id: task.id,
        expected_version: claimed.version,
        revision: 1,
        reviewer_actor_id: w.manager.id,
      }),
      'action_forbidden',
    );
    const submitted = await submitAs(
      w,
      task.id as never,
      claimed.version,
      claimed.fence,
      'x',
      w.manager,
    );
    // Stale version: still the separation error, not version_conflict.
    await expectCode(
      requestReview(w.manager.ctx(), {
        session_id: w.session.id,
        task_id: task.id,
        expected_version: submitted.version - 1,
        revision: 1,
        reviewer_actor_id: w.manager.id,
      }),
      'action_forbidden',
    );
    // Verdict: the owner-manager (allowed to review by the flag) with a stale version.
    const req = await requestReview(w.manager.ctx(), {
      session_id: w.session.id,
      task_id: task.id,
      expected_version: submitted.version,
      revision: 1,
      reviewer_actor_id: w.reviewer.id,
    });
    await expectCode(
      reviewVerdict(w.manager.ctx(), {
        session_id: w.session.id,
        review_id: req.review.id,
        expected_version: req.review.version + 5,
        verdict: 'approved',
        content_sha256: submitted.content_sha256,
      }),
      'action_forbidden',
    );
    // Lifecycle: a task still in `ready` cannot be reviewed, but the owner is still not a valid reviewer.
    const fresh = await newTask(w, { by: w.manager });
    await expectCode(
      requestReview(w.manager.ctx(), {
        session_id: w.session.id,
        task_id: fresh.id,
        expected_version: fresh.version,
        revision: 1,
        reviewer_actor_id: w.executor.id,
      }),
      'invalid_transition',
    );
  });

  it('B9: session B rows in claim_requests, comments, proposal_details and message_links are invisible to a session-A member and not insertable', async () => {
    const wa = await makeWorld(f, ws);
    const wb = await makeWorld(f, ws);
    const tb = await newTask(wb);
    const sid = wb.session.id;
    await f.owner(
      `INSERT INTO claim_requests (workspace_id, session_id, task_id, requester_actor_id)
       VALUES ($1, $2, $3, $4)`,
      [ws.id, sid, tb.id, wb.executor.id],
    );
    await f.owner(
      `INSERT INTO comments (workspace_id, session_id, item_id, author_actor_id, body) VALUES ($1, $2, $3, $4, 'hi')`,
      [ws.id, sid, tb.id, wb.executor.id],
    );
    const [proposal] = await f.owner<{ id: string }>(
      `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title, state, creator_actor_id)
       VALUES ($1, $2, $3, 'proposal', $4, 'p', 'open', $5) RETURNING id`,
      [ws.id, sid, wb.session.boardId, ws.roomId, wb.executor.id],
    );
    await f.owner(
      `INSERT INTO proposal_details (workspace_id, session_id, proposal_item_id, target_item_id, change_kind, payload)
       VALUES ($1, $2, $3, $4, 'other', '{}'::jsonb)`,
      [ws.id, sid, proposal?.id, tb.id],
    );
    await f.owner(
      `INSERT INTO message_links (workspace_id, session_id, item_id, sharednet_message_id, sharednet_sequence,
         sender_principal_id, sender_member_id, content_snapshot, content_sha256, linked_by)
       VALUES ($1, $2, $3, 'msg_1', 1, 'p_x', 'i_x', 'snap', repeat('a', 64), $4)`,
      [ws.id, sid, tb.id, wb.executor.id],
    );
    for (const table of ['claim_requests', 'comments', 'proposal_details', 'message_links']) {
      expect(
        await f.count(`SELECT count(*) AS n FROM ${table} WHERE session_id = $1`, [sid]),
        table,
      ).toBeGreaterThan(0);
    }
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
        [ws.id, wa.executor.id],
      );
      for (const table of ['claim_requests', 'comments', 'proposal_details', 'message_links']) {
        const seen = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table} WHERE session_id = $1`,
          [sid],
        );
        expect(Number(seen.rows[0]?.n), `${table}: A must not see B`).toBe(0);
      }
      // INSERTs that name B's session are rejected by RLS (42501), for the tables chorus_app may write.
      const attempts: [string, unknown[]][] = [
        [
          `INSERT INTO claim_requests (workspace_id, session_id, task_id, requester_actor_id) VALUES ($1, $2, $3, $4)`,
          [ws.id, sid, tb.id, wa.executor.id],
        ],
        [
          `INSERT INTO comments (workspace_id, session_id, item_id, author_actor_id, body) VALUES ($1, $2, $3, $4, 'x')`,
          [ws.id, sid, tb.id, wa.executor.id],
        ],
        [
          `INSERT INTO proposal_details (workspace_id, session_id, proposal_item_id, target_item_id, change_kind, payload)
           VALUES ($1, $2, $3, $4, 'other', '{}'::jsonb)`,
          [ws.id, sid, proposal?.id, tb.id],
        ],
        [
          `INSERT INTO message_links (workspace_id, session_id, item_id, sharednet_message_id, sharednet_sequence,
             sender_principal_id, sender_member_id, content_snapshot, content_sha256, linked_by)
           VALUES ($1, $2, $3, 'm', 1, 'p', 'i', 's', repeat('b', 64), $4)`,
          [ws.id, sid, tb.id, wa.executor.id],
        ],
      ];
      for (const [sql, params] of attempts) {
        await client.query('SAVEPOINT s');
        await expect(client.query(sql, params)).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('A4.4-1: the completion gate uses the flag recorded at verdict time, not the current one', async () => {
    const w = await makeWorld(f, ws, { managerReview: true });
    const t = await taskInReview(w);
    const req = await requestReviewAs(w, t.taskId, t.version, t.revision, w.manager);
    // Block the task so the approval stands but auto-completion does not happen.
    await f.owner(
      `UPDATE work_items SET blocked_at = now(), blocked_reason = 'waiting' WHERE id = $1`,
      [t.taskId],
    );
    const approved = await verdictAs(w, req.review, t.digest, 'approved', w.manager);
    expect(approved.task.state).toBe('review');
    const [rec] = await f.owner<{ f: boolean; r: string[] }>(
      `SELECT verdict_manager_review_allowed AS f, verdict_reviewer_roles AS r FROM review_details WHERE review_item_id = $1`,
      [req.review.id],
    );
    expect(rec).toEqual({ f: true, r: ['participant', 'manager', 'administrator'] });
    // The blocker clears and an administrator turns manager review off afterwards.
    await f.owner(`UPDATE work_items SET blocked_at = NULL, blocked_reason = NULL WHERE id = $1`, [
      t.taskId,
    ]);
    await setSessionPolicy(w.manager.ctx(), {
      session_id: w.session.id,
      expected_version: await version(w.session.id),
      manager_review_allowed: false,
    });
    const [row] = await f.owner<{ version: number }>(
      'SELECT version FROM work_items WHERE id = $1',
      [t.taskId],
    );
    const done = await completeTask(w.manager.ctx(), {
      session_id: w.session.id,
      task_id: t.taskId,
      expected_version: row?.version,
    });
    expect(done.state).toBe('done');
  });

  it('A4.4-4: the database refuses to leave a session without a live administrator (CH005)', async () => {
    const w = await makeWorld(f, ws);
    const other = await w.participant('other-admin');
    const client = await f.pool.connect();
    const asManager = async () => {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
        [ws.id, w.manager.id],
      );
    };
    try {
      await asManager();
      await expect(
        client.query(
          `SELECT * FROM chorus_session_set_roles($1, $2, ARRAY['participant','manager'])`,
          [w.session.id, w.manager.id],
        ),
      ).rejects.toMatchObject({ code: 'CH005' });
      await asManager();
      await expect(
        client.query('SELECT chorus_session_remove_member($1, $2)', [w.session.id, w.manager.id]),
      ).rejects.toMatchObject({ code: 'CH005' });
      // With a second LIVE administrator both are allowed; a room-removed one does not count.
      await f.owner(
        `UPDATE session_members SET roles = ARRAY['participant','administrator'] WHERE session_id = $1 AND actor_id = $2`,
        [w.session.id, other.id],
      );
      await removeFromRoom(other);
      await asManager();
      await expect(
        client.query(
          `SELECT * FROM chorus_session_set_roles($1, $2, ARRAY['participant','manager'])`,
          [w.session.id, w.manager.id],
        ),
      ).rejects.toMatchObject({ code: 'CH005' });
      await f.owner(
        `UPDATE room_members SET removed_at = NULL WHERE workspace_id = $1 AND room_id = $2 AND actor_id = $3`,
        [ws.id, ws.roomId, other.id],
      );
      await asManager();
      const ok = await client.query(
        `SELECT * FROM chorus_session_set_roles($1, $2, ARRAY['participant','manager'])`,
        [w.session.id, w.manager.id],
      );
      expect(ok.rows).toHaveLength(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release(true);
    }
  });
});
