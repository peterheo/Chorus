import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TASK_SOURCE_STATES,
  TASK_STATES,
  claim,
  completeTask,
  createTask,
  getTask,
  isChorusError,
  renewLease,
  requestReview,
  reviewVerdict,
  submitResult,
  type ChorusError,
  type ErrorCode,
  type TaskCommand,
  type Uuid,
} from '../../src/index.ts';
import { createFixture, type Fixture } from '../helpers/fixture.ts';
import {
  CRITERIA,
  MAPPING,
  claimAs,
  makeWorld,
  newTask,
  requestReviewAs,
  submitAs,
  taskInReview,
  uniqueKey,
  verdictAs,
  type World,
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

describe('RC-WP2 lifecycle (real PostgreSQL, as chorus_app)', () => {
  let f: Fixture;
  let w: World;

  beforeAll(async () => {
    f = await createFixture();
    w = await makeWorld(f, f.a);
  });
  afterAll(async () => {
    await f.close();
  });

  const owner = <T extends object>(sql: string, params: unknown[] = []) =>
    f.db.query<T & Record<string, unknown>>(sql, params);
  const leaseOf = async (taskId: string) => {
    const [row] = await owner<{ fence: string; instance_id: string | null; live: boolean }>(
      `SELECT fence, instance_id, COALESCE(instance_id IS NOT NULL AND expires_at > now(), false) AS live
         FROM task_leases WHERE task_id = $1`,
      [taskId],
    );
    if (row === undefined) throw new Error('no lease');
    return { fence: Number(row.fence), instanceId: row.instance_id, live: row.live };
  };
  const expireLease = (taskId: string) =>
    owner(`UPDATE task_leases SET expires_at = now() - interval '1 second' WHERE task_id = $1`, [
      taskId,
    ]);

  // ------------------------------------------------------------------------------------------------
  it('lifecycle.transitions.matrix', async () => {
    const commands: TaskCommand[] = [
      'claim',
      'renew_lease',
      'submit_result',
      'request_review',
      'complete',
    ];

    async function prepare(command: TaskCommand, state: string) {
      const task = await newTask(w, { reviewRequired: command !== 'complete' });
      const id = task.id as Uuid;
      await owner(`UPDATE work_items SET state = $2, owner_actor_id = $3 WHERE id = $1`, [
        id,
        state,
        w.executor.actorId,
      ]);
      if (command === 'renew_lease' || command === 'submit_result') {
        await owner(
          `UPDATE task_leases SET fence = 1, instance_id = $2, expires_at = now() + interval '1 hour' WHERE task_id = $1`,
          [id, w.executor.instanceId],
        );
      }
      if (command === 'request_review' || command === 'complete') {
        const content = 'seeded';
        await owner(
          `INSERT INTO task_result_revisions
             (workspace_id, task_id, revision, content, content_sha256, byte_length, submitted_by, fence)
           VALUES ($1, $2, 1, $3, encode(digest($3, 'sha256'), 'hex'), 6, $4, 1)`,
          [w.ws.id, id, content, w.executor.actorId],
        );
      }
      return id;
    }

    for (const command of commands) {
      for (const state of TASK_STATES) {
        const id = await prepare(command, state);
        const call = () => {
          const base = { task_id: id, expected_version: 1 };
          switch (command) {
            case 'claim':
              return claim(w.executor.ctx(), base);
            case 'renew_lease':
              return renewLease(w.executor.ctx(), { ...base, fence: 1 });
            case 'submit_result':
              return submitResult(w.executor.ctx(), {
                ...base,
                fence: 1,
                content: 'x',
                content_type: 'text/plain',
                criteria_mapping: MAPPING,
              });
            case 'request_review':
              return requestReview(w.executor.ctx(), {
                ...base,
                revision: 1,
                reviewer_actor_id: w.reviewer.actorId,
              });
            case 'complete':
              return completeTask(w.executor.ctx(), base);
          }
        };
        const allowed = TASK_SOURCE_STATES[command].includes(state);
        if (allowed) {
          await expect(call(), `${command} from ${state} should succeed`).resolves.toBeDefined();
        } else {
          const error = await failure(call());
          expect(error.code, `${command} from ${state}`).toBe('invalid_transition');
          expect(error.details['reason']).toBe(
            command === 'claim' && state === 'done' ? 'terminal' : 'invalid_state',
          );
          expect(error.details['state']).toBe(state);
        }
      }
    }
  });

  // ------------------------------------------------------------------------------------------------
  it('claim.concurrent.single_holder', async () => {
    const task = await newTask(w);
    const agents = await Promise.all(Array.from({ length: 100 }, () => w.agent('executor')));
    const outcomes = await Promise.all(
      agents.map((a) =>
        claim(a.ctx(), { task_id: task.id, expected_version: task.version }).then(
          () => 'won' as const,
          (e: unknown) => (isChorusError(e) ? e.code : String(e)),
        ),
      ),
    );
    expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
    const losers = outcomes.filter((o) => o !== 'won');
    expect(losers).toHaveLength(99);
    for (const code of losers) {
      expect(['version_conflict', 'owner_conflict', 'lease_conflict']).toContain(code);
    }
    expect(
      await f.count(
        `SELECT count(*) AS n FROM task_leases WHERE task_id = $1 AND instance_id IS NOT NULL`,
        [task.id],
      ),
    ).toBe(1);
    expect((await leaseOf(task.id)).fence).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------
  it('lease.expiry.fence_advances', async () => {
    const task = await newTask(w);
    const first = await claimAs(w, task.id as Uuid, task.version);
    expect(first.fence).toBe(1);
    await expireLease(task.id);

    await expectCode(
      renewLease(w.executor.ctx(), {
        task_id: task.id,
        expected_version: first.version,
        fence: first.fence,
      }),
      'lease_lost',
    );
    const second = await claimAs(w, task.id as Uuid, first.version);
    expect(second.fence).toBe(2);
    await expectCode(submitAs(w, task.id as Uuid, second.version, first.fence), 'lease_lost');
    // The fresh fence works.
    await expect(submitAs(w, task.id as Uuid, second.version, second.fence)).resolves.toMatchObject(
      { revision: 1 },
    );
  });

  it('lease.renew.version_bump', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    const renewed = await renewLease(w.executor.ctx(), {
      task_id: task.id,
      expected_version: claimed.version,
      fence: claimed.fence,
    });
    expect(renewed.version).toBe(claimed.version + 1);
    await expectCode(
      submitAs(w, task.id as Uuid, claimed.version, claimed.fence),
      'version_conflict',
    );
    await expect(
      submitAs(w, task.id as Uuid, renewed.version, claimed.fence),
    ).resolves.toMatchObject({ state: 'review' });
  });

  // ------------------------------------------------------------------------------------------------
  it('review.invalidation.new_revision', async () => {
    const t = await taskInReview(w);
    const r1 = await requestReviewAs(w, t.taskId, t.version, 1);
    await verdictAs(r1.review, t.digest, 'approved', w.reviewer);

    // Reclaim, revise: the rev-1 approval no longer covers the latest revision.
    const reclaimed = await claimAs(w, t.taskId, r1.task_version);
    const rev2 = await submitAs(w, t.taskId, reclaimed.version, reclaimed.fence, 'revised result');
    expect(rev2.revision).toBe(2);
    await expectCode(
      completeTask(w.executor.ctx(), { task_id: t.taskId, expected_version: rev2.version }),
      'review_required',
    );

    const r2 = await requestReviewAs(w, t.taskId, rev2.version, 2);
    await verdictAs(r2.review, rev2.content_sha256, 'approved', w.reviewer);
    const done = await completeTask(w.executor.ctx(), {
      task_id: t.taskId,
      expected_version: r2.task_version,
    });
    expect(done.state).toBe('done');
  });

  it('claim.review_pending', async () => {
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1);
    await expectCode(claimAs(w, t.taskId, r.task_version), 'invalid_transition', 'review_pending');
    const verdict = await verdictAs(r.review, t.digest, 'changes_requested', w.reviewer);
    expect(verdict.review.state).toBe('changes_requested');
    // A verdict does not move the task or its version.
    const view = await getTask(w.executor.ctx(), { task_id: t.taskId });
    expect(view.state).toBe('review');
    expect(view.version).toBe(r.task_version);
    const reclaimed = await claimAs(w, t.taskId, r.task_version);
    expect(reclaimed.fence).toBe(2);
    expect(reclaimed.state).toBe('in_progress');
  });

  it('review.verdict.gates', async () => {
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1);
    const wrong = '0'.repeat(64);
    await expectCode(verdictAs(r.review, wrong, 'approved', w.reviewer), 'subject_digest_mismatch');

    // A newer revision cannot be produced through the API while a review is requested (reclaim is
    // blocked), so the superseding revision is planted with owner rights to exercise the stale gate.
    await owner(
      `INSERT INTO task_result_revisions
         (workspace_id, task_id, revision, content, content_sha256, byte_length, submitted_by, fence)
       VALUES ($1, $2, 2, 'planted', encode(digest('planted', 'sha256'), 'hex'), 7, $3, 1)`,
      [w.ws.id, t.taskId, w.executor.actorId],
    );
    await expectCode(verdictAs(r.review, t.digest, 'approved', w.reviewer), 'review_stale');
    // Stale wins over a wrong digest (precedence).
    await expectCode(verdictAs(r.review, wrong, 'approved', w.reviewer), 'review_stale');

    // Verdict finality on a fresh, non-stale review.
    const t2 = await taskInReview(w);
    const r2 = await requestReviewAs(w, t2.taskId, t2.version, 1);
    const done = await verdictAs(r2.review, t2.digest, 'approved', w.reviewer, 'looks good');
    expect(done.review).toMatchObject({ state: 'approved', verdict: 'approved', stale: false });
    await expectCode(
      reviewVerdict(w.reviewer.ctx(), {
        review_id: r2.review.id,
        expected_version: done.review.version,
        verdict: 'changes_requested',
        content_sha256: t2.digest,
      }),
      'invalid_transition',
      'verdict_final',
    );
  });

  it('review.request.unique', async () => {
    const t = await taskInReview(w);
    const first = await requestReviewAs(w, t.taskId, t.version, 1);
    await expectCode(
      requestReviewAs(w, t.taskId, first.task_version, 1, w.reviewer2),
      'review_exists',
    );

    const t2 = await taskInReview(w);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        requestReviewAs(w, t2.taskId, t2.version, 1).then(
          () => 'ok' as const,
          (e: unknown) => (isChorusError(e) ? e.code : String(e)),
        ),
      ),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(
      await f.count(`SELECT count(*) AS n FROM review_details WHERE subject_task_id = $1`, [
        t2.taskId,
      ]),
    ).toBe(1);
  });

  it('review.request.eligibility', async () => {
    const t = await taskInReview(w);
    // The submitter cannot review their own work, even if they hold the reviewer role too.
    await f.db.query(
      `INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, 'reviewer')`,
      [w.ws.id, w.executor.actorId, w.roomId],
    );
    await expectCode(
      requestReview(w.executor.ctx(), {
        task_id: t.taskId,
        expected_version: t.version,
        revision: 1,
        reviewer_actor_id: w.executor.actorId,
      }),
      'action_forbidden',
      'reviewer_is_submitter',
    );
    // A reviewer must hold the reviewer role in the room.
    await expectCode(
      requestReview(w.executor.ctx(), {
        task_id: t.taskId,
        expected_version: t.version,
        revision: 1,
        reviewer_actor_id: w.executor2.actorId,
      }),
      'invalid_request',
      'reviewer_not_eligible',
    );
  });

  // ------------------------------------------------------------------------------------------------
  it('complete.truth_table', async () => {
    const complete = (t: { taskId: Uuid }, version: number) =>
      completeTask(w.executor.ctx(), { task_id: t.taskId, expected_version: version });

    // review_required = false: done with or without any review.
    const none = await taskInReview(w, { reviewRequired: false });
    expect((await complete(none, none.version)).state).toBe('done');
    const withVerdict = await taskInReview(w, { reviewRequired: false });
    const rv = await requestReviewAs(w, withVerdict.taskId, withVerdict.version, 1);
    await verdictAs(rv.review, withVerdict.digest, 'changes_requested', w.reviewer);
    expect((await complete(withVerdict, rv.task_version)).state).toBe('done');

    // review_required = true, latest revision reviewed / not reviewed.
    const noReview = await taskInReview(w);
    await expectCode(complete(noReview, noReview.version), 'review_required');

    const requested = await taskInReview(w);
    const rq = await requestReviewAs(w, requested.taskId, requested.version, 1);
    await expectCode(complete(requested, rq.task_version), 'review_required');

    const changes = await taskInReview(w);
    const rc = await requestReviewAs(w, changes.taskId, changes.version, 1);
    await verdictAs(rc.review, changes.digest, 'changes_requested', w.reviewer);
    await expectCode(complete(changes, rc.task_version), 'review_required');

    const approved = await taskInReview(w);
    const ra = await requestReviewAs(w, approved.taskId, approved.version, 1);
    await verdictAs(ra.review, approved.digest, 'approved', w.reviewer);
    expect((await complete(approved, ra.task_version)).state).toBe('done');

    // Only reviews of OLDER revisions exist.
    const older = await taskInReview(w);
    const ro = await requestReviewAs(w, older.taskId, older.version, 1);
    await verdictAs(ro.review, older.digest, 'approved', w.reviewer);
    const again = await claimAs(w, older.taskId, ro.task_version);
    const rev2 = await submitAs(w, older.taskId, again.version, again.fence, 'second');
    await expectCode(complete(older, rev2.version), 'review_required');
  });

  // ------------------------------------------------------------------------------------------------
  it('authz.lifecycle', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    // Not the owner: owner_conflict, even with a valid role and its own instance.
    await expectCode(
      submitAs(w, task.id as Uuid, claimed.version, claimed.fence, 'x', w.executor2),
      'owner_conflict',
    );
    // No grant in the room at all: not_found, never 403.
    const outsider = await w.agent(null);
    await expectCode(
      claim(outsider.ctx(), { task_id: task.id, expected_version: claimed.version }),
      'not_found',
    );
    // A reviewer cannot create tasks; a task's creation needs manager.
    const forbidden = await failure(
      createTask(w.reviewer.ctx(), {
        room_id: w.roomId,
        title: 'nope',
        acceptance_criteria: ['c'],
      }),
    );
    expect(forbidden.code).toBe('action_forbidden');
    await expectCode(
      createTask(w.executor.ctx(), {
        room_id: w.roomId,
        title: 'nope',
        acceptance_criteria: ['c'],
      }),
      'action_forbidden',
    );
    // Claiming requires an agent instance.
    const noInstance = f.ctx(w.ws, w.executor2.actorId, uniqueKey(), null);
    const t2 = await newTask(w);
    await expectCode(
      claim(noInstance, { task_id: t2.id, expected_version: t2.version }),
      'action_forbidden',
      'instance_required',
    );
    // A verdict must come from the assigned reviewer.
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1, w.reviewer);
    await expectCode(
      verdictAs(r.review, t.digest, 'approved', w.reviewer2),
      'action_forbidden',
      'not_assigned_reviewer',
    );
    // Only the owner or a manager can request a review or complete.
    await expectCode(
      requestReview(w.executor2.ctx(), {
        task_id: t.taskId,
        expected_version: r.task_version,
        revision: 1,
        reviewer_actor_id: w.reviewer2.actorId,
      }),
      'action_forbidden',
      'not_owner',
    );
  });

  // ------------------------------------------------------------------------------------------------
  it('submit.validation', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    const base = {
      task_id: task.id,
      expected_version: claimed.version,
      fence: claimed.fence,
      content: 'ok',
      content_type: 'text/plain',
      criteria_mapping: MAPPING,
    };
    const submit = (over: Record<string, unknown>) =>
      submitResult(w.executor.ctx(), { ...base, ...over });

    // Coverage problems are evidence_required (422): missing, duplicate, out of range.
    for (const mapping of [
      [MAPPING[0]],
      [MAPPING[0], MAPPING[0]],
      [MAPPING[0], { criterion: 2, note: 'x' }],
      [MAPPING[0], { criterion: -1, note: 'x' }],
      [],
    ]) {
      const error = await failure(submit({ criteria_mapping: mapping }));
      expect(error.code).toBe('evidence_required');
      expect(error.status).toBe(422);
    }
    // Shape / limit problems are invalid_request (400).
    const big = 'a'.repeat(262145);
    expect((await failure(submit({ content: big }))).details['field']).toBe('content');
    await expectCode(submit({ content: '' }), 'invalid_request');
    await expectCode(
      submit({ content: '{not json', content_type: 'application/json' }),
      'invalid_request',
    );
    await expectCode(submit({ content_type: 'text/html' }), 'invalid_request');
    await expectCode(
      submit({ criteria_mapping: [{ criterion: 0 }, MAPPING[1]] }),
      'invalid_request',
    );
    await expectCode(
      submit({ supporting_refs: [{ url: 'http://insecure.example/x', label: 'x' }] }),
      'invalid_request',
    );
    await expectCode(
      submit({
        supporting_refs: Array.from({ length: 11 }, () => ({
          url: 'https://a.example/x',
          label: 'x',
        })),
      }),
      'invalid_request',
    );
    await expectCode(submit({ unexpected: 1 }), 'invalid_request');
    await expectCode(submit({ content: 'a\u0000b' }), 'invalid_request');
    await expectCode(submit({ content: 'lone \ud800 surrogate' }), 'invalid_request');
    expect(
      await f.count(`SELECT count(*) AS n FROM task_result_revisions WHERE task_id = $1`, [
        task.id,
      ]),
    ).toBe(0);

    // Exact bytes and digest, multi-byte UTF-8, JSON preserved without re-serialization.
    const text = '  héllo — 世界 🚀\n  ';
    const result = await submit({
      content: text,
      supporting_refs: [{ url: 'https://example.com/evidence', label: 'ev' }],
    });
    expect(result.byte_length).toBe(Buffer.byteLength(text, 'utf8'));
    const [row] = await owner<{
      content: string;
      content_sha256: string;
      byte_length: number;
      digest_ok: boolean;
    }>(
      `SELECT content, content_sha256, byte_length,
              content_sha256 = encode(digest(convert_to(content, 'UTF8'), 'sha256'), 'hex') AS digest_ok
         FROM task_result_revisions WHERE task_id = $1`,
      [task.id],
    );
    expect(row?.content).toBe(text);
    expect(row?.digest_ok).toBe(true);
    expect(row?.content_sha256).toBe(result.content_sha256);

    const jsonTask = await newTask(w);
    const jc = await claimAs(w, jsonTask.id as Uuid, jsonTask.version);
    const spaced = '{ "a" :   1,\n "b": [1, 2] }';
    await submitResult(w.executor.ctx(), {
      ...base,
      task_id: jsonTask.id,
      expected_version: jc.version,
      fence: jc.fence,
      content: spaced,
      content_type: 'application/json',
    });
    const [stored] = await owner<{ content: string }>(
      'SELECT content FROM task_result_revisions WHERE task_id = $1',
      [jsonTask.id],
    );
    expect(stored?.content).toBe(spaced);
    expect(CRITERIA).toHaveLength(2);
  });

  // ------------------------------------------------------------------------------------------------
  it('idempotency.lifecycle_replay', async () => {
    const task = await newTask(w);
    const claimKey = uniqueKey('claim');
    const ctxClaim = f.ctx(w.ws, w.executor.actorId, claimKey, w.executor.instanceId);
    const first = await claim(ctxClaim, { task_id: task.id, expected_version: task.version });
    const replay = await claim(ctxClaim, { task_id: task.id, expected_version: task.version });
    expect(replay).toEqual(first);
    expect((await leaseOf(task.id)).fence).toBe(1);

    const submitKey = uniqueKey('submit');
    const ctxSubmit = f.ctx(w.ws, w.executor.actorId, submitKey, w.executor.instanceId);
    const submitInput = {
      task_id: task.id,
      expected_version: first.version,
      fence: first.fence,
      content: 'once',
      content_type: 'text/plain',
      criteria_mapping: MAPPING,
    };
    const s1 = await submitResult(ctxSubmit, submitInput);
    // The task has moved on (state review, new version), yet the stored response stands.
    expect(await submitResult(ctxSubmit, submitInput)).toEqual(s1);
    expect(
      await f.count(`SELECT count(*) AS n FROM task_result_revisions WHERE task_id = $1`, [
        task.id,
      ]),
    ).toBe(1);

    // Same key with a different body is a conflict.
    await expectCode(
      submitResult(ctxSubmit, { ...submitInput, content: 'twice' }),
      'idempotency_conflict',
    );

    // A revoked grant cannot fetch the stored result through the replay path.
    const temp = await w.agent('executor');
    const t2 = await newTask(w);
    const ctxTemp = temp.ctx(uniqueKey('rev'));
    const c2 = await claim(ctxTemp, { task_id: t2.id, expected_version: t2.version });
    await owner('UPDATE room_grants SET revoked_at = now() WHERE actor_id = $1', [temp.actorId]);
    const error = await expectCode(
      claim(ctxTemp, { task_id: t2.id, expected_version: t2.version }),
      'not_found',
    );
    expect(JSON.stringify(error)).not.toContain(String(c2.fence) + '"expires_at"');
    expect((await leaseOf(t2.id)).fence).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------
  it('events.one_per_version', async () => {
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1);
    await verdictAs(r.review, t.digest, 'approved', w.reviewer);
    await completeTask(w.executor.ctx(), { task_id: t.taskId, expected_version: r.task_version });

    const events = await owner<{
      aggregate_id: string;
      aggregate_version: number;
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT aggregate_id, aggregate_version, event_type, payload FROM domain_events
        WHERE aggregate_id = ANY($1::uuid[]) ORDER BY aggregate_id, aggregate_version`,
      [[t.taskId, r.review.id]],
    );
    const byAggregate = new Map<string, typeof events>();
    for (const e of events)
      byAggregate.set(e.aggregate_id, [...(byAggregate.get(e.aggregate_id) ?? []), e]);

    expect(byAggregate.get(t.taskId)?.map((e) => [e.aggregate_version, e.event_type])).toEqual([
      [1, 'task.created'],
      [2, 'task.claimed'],
      [3, 'task.result_submitted'],
      [4, 'task.review_requested'],
      [5, 'task.completed'],
    ]);
    expect(byAggregate.get(r.review.id)?.map((e) => [e.aggregate_version, e.event_type])).toEqual([
      [1, 'review.requested'],
      [2, 'review.verdict_recorded'],
    ]);
    // Payloads carry no content.
    for (const e of events) expect(JSON.stringify(e.payload)).not.toContain('the result');
    // The task row version equals its last event version.
    const view = await getTask(w.executor.ctx(), { task_id: t.taskId });
    expect(view.version).toBe(5);
  });

  // ------------------------------------------------------------------------------------------------
  it('errors.precedence', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);

    // 1 invalid_request beats not_found: validation runs before any lookup.
    const outsider = await w.agent(null);
    await expectCode(
      claim(outsider.ctx(), { task_id: 'not-a-uuid', expected_version: 1 }),
      'invalid_request',
    );
    // 4 not_found beats 5 action_forbidden and 6 version_conflict.
    await expectCode(
      claim(outsider.ctx(), { task_id: task.id, expected_version: 99 }),
      'not_found',
    );
    // 5 action_forbidden beats 6 version_conflict (reviewer-only actor, wrong version).
    await expectCode(
      claim(w.reviewer.ctx(), { task_id: task.id, expected_version: 99 }),
      'action_forbidden',
    );
    // 6 version_conflict beats 7 invalid_transition (completing a task in progress with a stale version).
    await expectCode(
      completeTask(w.executor.ctx(), { task_id: task.id, expected_version: 99 }),
      'version_conflict',
    );
    await expectCode(
      completeTask(w.executor.ctx(), { task_id: task.id, expected_version: claimed.version }),
      'invalid_transition',
    );
    // 8 owner_conflict beats 9 lease_conflict (task has a live lease held by someone else).
    await expectCode(
      claim(w.executor2.ctx(), { task_id: task.id, expected_version: claimed.version }),
      'owner_conflict',
    );
    // 9 lease_lost beats 10 evidence_required (stale fence AND an empty mapping).
    await expectCode(
      submitResult(w.executor.ctx(), {
        task_id: task.id,
        expected_version: claimed.version,
        fence: claimed.fence + 5,
        content: 'x',
        content_type: 'text/plain',
        criteria_mapping: [],
      }),
      'lease_lost',
    );
    // 7 invalid_transition beats 8 owner_conflict: a non-owner claiming under a pending review.
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1);
    await expectCode(
      claim(w.executor2.ctx(), { task_id: t.taskId, expected_version: r.task_version }),
      'invalid_transition',
      'review_pending',
    );
    // 11 review_stale beats subject_digest_mismatch was covered in review.verdict.gates.
  });
});
