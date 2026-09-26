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

describe('task and review lifecycle in a session (real PostgreSQL, as chorus_app)', () => {
  let f: Fixture;
  let w: World;
  let sid: string;

  beforeAll(async () => {
    // 100 concurrent claims must really contend: give the app pool room for 40 connections.
    f = await createFixture({ poolMax: 36 });
    w = await makeWorld(f, await f.workspace('life'));
    sid = w.session.id;
  });
  afterAll(async () => {
    await f.close();
  });

  const owner = <T extends object>(sql: string, params: unknown[] = []) =>
    f.owner<T & Record<string, unknown>>(sql, params);
  const leaseOf = async (taskId: string) => {
    const [row] = await owner<{ fence: string; instance_id: string | null; live: boolean }>(
      `SELECT fence, instance_id, COALESCE(instance_id IS NOT NULL AND expires_at > now(), false) AS live FROM task_leases WHERE task_id = $1`,
      [taskId],
    );
    if (row === undefined) throw new Error('no lease');
    return { fence: Number(row.fence), instanceId: row.instance_id, live: row.live };
  };
  const expireLease = (taskId: string) =>
    owner(`UPDATE task_leases SET expires_at = now() - interval '1 second' WHERE task_id = $1`, [
      taskId,
    ]);
  const stateOf = async (id: string) =>
    (
      await owner<{ state: string; version: number }>(
        'SELECT state, version FROM work_items WHERE id = $1',
        [id],
      )
    )[0];

  it('lifecycle.transitions.matrix: every allowed source state succeeds, every other is invalid_transition', async () => {
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
        w.executor.id,
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
          `INSERT INTO task_result_revisions (workspace_id, session_id, task_id, revision, content, content_sha256, byte_length, submitted_by, fence)
           VALUES ($1, $2, $3, 1, $4, encode(digest($4, 'sha256'), 'hex'), 6, $5, 1)`,
          [w.ws.id, sid, id, content, w.executor.id],
        );
      }
      return id;
    }
    for (const command of commands) {
      for (const state of TASK_STATES) {
        const id = await prepare(command, state);
        const base = { session_id: sid, task_id: id, expected_version: 1 };
        const call = () => {
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
                reviewer_actor_id: w.reviewer.id,
              });
            case 'complete':
              return completeTask(w.manager.ctx(), base);
          }
        };
        if (TASK_SOURCE_STATES[command].includes(state)) {
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

  it('claim.concurrent.single_holder: 100 distinct participants race; exactly one wins', async () => {
    const task = await newTask(w);
    const agents = await Promise.all(Array.from({ length: 100 }, () => w.participant()));
    const outcomes = await Promise.all(
      agents.map((a) =>
        claim(a.ctx(), { session_id: sid, task_id: task.id, expected_version: task.version }).then(
          () => 'won' as const,
          (e: unknown) => (isChorusError(e) ? e.code : String(e)),
        ),
      ),
    );
    expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
    const losers = outcomes.filter((o) => o !== 'won');
    expect(losers).toHaveLength(99);
    for (const code of losers)
      expect(['version_conflict', 'owner_conflict', 'lease_conflict']).toContain(code);
    expect(
      await f.count(
        `SELECT count(*) AS n FROM task_leases WHERE task_id = $1 AND instance_id IS NOT NULL`,
        [task.id],
      ),
    ).toBe(1);
    expect((await leaseOf(task.id)).fence).toBe(1);
  });

  it('lease.expiry.fence_advances', async () => {
    const task = await newTask(w);
    const first = await claimAs(w, task.id as Uuid, task.version);
    expect(first.fence).toBe(1);
    await expireLease(task.id);
    await expectCode(
      renewLease(w.executor.ctx(), {
        session_id: sid,
        task_id: task.id,
        expected_version: first.version,
        fence: first.fence,
      }),
      'lease_lost',
    );
    const second = await claimAs(w, task.id as Uuid, first.version);
    expect(second.fence).toBe(2);
    await expectCode(submitAs(w, task.id as Uuid, second.version, first.fence), 'lease_lost');
    await expect(submitAs(w, task.id as Uuid, second.version, second.fence)).resolves.toMatchObject(
      { revision: 1 },
    );
  });

  it('lease.renew.version_bump', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    const renewed = await renewLease(w.executor.ctx(), {
      session_id: sid,
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

  describe('review and automatic completion', () => {
    it('review.auto_complete: an approval of the latest revision completes the task in the same transaction', async () => {
      const t = await taskInReview(w);
      const r = await requestReviewAs(w, t.taskId, t.version, 1);
      const verdict = await verdictAs(w, r.review, t.digest, 'approved', w.reviewer);
      expect(verdict.review).toMatchObject({ state: 'approved', verdict: 'approved' });
      expect(verdict.task).toEqual({ id: t.taskId, version: r.task_version + 1, state: 'done' });
      expect(await stateOf(t.taskId)).toEqual({ state: 'done', version: r.task_version + 1 });
      // The lease is released and a completed task cannot be reclaimed.
      expect((await leaseOf(t.taskId)).live).toBe(false);
      await expectCode(claimAs(w, t.taskId, r.task_version + 1), 'invalid_transition', 'terminal');
      const events = await owner<{
        event_type: string;
        aggregate_version: number;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_type, aggregate_version, payload FROM domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version DESC LIMIT 1`,
        [t.taskId],
      );
      expect(events[0]).toMatchObject({
        event_type: 'task.completed',
        payload: { trigger: 'review_approved', revision: 1 },
      });
    });

    it('review.changes_requested.new_revision: a later revision needs its own approval; manager complete does not bypass', async () => {
      const t = await taskInReview(w);
      const r1 = await requestReviewAs(w, t.taskId, t.version, 1);
      const rejected = await verdictAs(w, r1.review, t.digest, 'changes_requested', w.reviewer);
      // A verdict never moves the task.
      expect(rejected.task).toEqual({ id: t.taskId, version: r1.task_version, state: 'review' });
      const reclaimed = await claimAs(w, t.taskId, r1.task_version);
      const rev2 = await submitAs(
        w,
        t.taskId,
        reclaimed.version,
        reclaimed.fence,
        'revised result',
      );
      expect(rev2.revision).toBe(2);
      await expectCode(
        completeTask(w.manager.ctx(), {
          session_id: sid,
          task_id: t.taskId,
          expected_version: rev2.version,
        }),
        'review_required',
      );
      const r2 = await requestReviewAs(w, t.taskId, rev2.version, 2);
      const approved = await verdictAs(w, r2.review, rev2.content_sha256, 'approved', w.reviewer);
      expect(approved.task.state).toBe('done');
    });

    it('claim.review_pending: reclaim is refused while a review is requested, allowed after changes_requested', async () => {
      const t = await taskInReview(w);
      const r = await requestReviewAs(w, t.taskId, t.version, 1);
      await expectCode(
        claimAs(w, t.taskId, r.task_version),
        'invalid_transition',
        'review_pending',
      );
      await verdictAs(w, r.review, t.digest, 'changes_requested', w.reviewer);
      const view = await getTask(f.readCtx(w.executor), { session_id: sid, task_id: t.taskId });
      expect(view).toMatchObject({ state: 'review', version: r.task_version });
      const reclaimed = await claimAs(w, t.taskId, r.task_version);
      expect(reclaimed).toMatchObject({ fence: 2, state: 'in_progress' });
    });

    it('review.verdict.gates: wrong digest, stale revision, and finality', async () => {
      const t = await taskInReview(w);
      const r = await requestReviewAs(w, t.taskId, t.version, 1);
      const wrong = '0'.repeat(64);
      await expectCode(
        verdictAs(w, r.review, wrong, 'approved', w.reviewer),
        'subject_digest_mismatch',
      );
      // A newer revision cannot be produced through the API while a review is pending, so plant one.
      await owner(
        `INSERT INTO task_result_revisions (workspace_id, session_id, task_id, revision, content, content_sha256, byte_length, submitted_by, fence)
         VALUES ($1, $2, $3, 2, 'planted', encode(digest('planted', 'sha256'), 'hex'), 7, $4, 1)`,
        [w.ws.id, sid, t.taskId, w.executor.id],
      );
      await expectCode(verdictAs(w, r.review, t.digest, 'approved', w.reviewer), 'review_stale');
      await expectCode(verdictAs(w, r.review, wrong, 'approved', w.reviewer), 'review_stale');

      const t2 = await taskInReview(w);
      const r2 = await requestReviewAs(w, t2.taskId, t2.version, 1);
      const changes = await verdictAs(
        w,
        r2.review,
        t2.digest,
        'changes_requested',
        w.reviewer,
        'needs work',
      );
      expect(changes.review).toMatchObject({ state: 'changes_requested', stale: false });
      await expectCode(
        reviewVerdict(w.reviewer.ctx(), {
          session_id: sid,
          review_id: r2.review.id,
          expected_version: changes.review.version,
          verdict: 'approved',
          content_sha256: t2.digest,
        }),
        'invalid_transition',
        'verdict_final',
      );
    });

    it('review.request.unique: a duplicate is review_exists; 10 concurrent requests make one review', async () => {
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

    it('review.separation: the owner and submitter can never review; a manager reviews only if the session allows it', async () => {
      const t = await taskInReview(w);
      // The owner/submitter is the executor: not eligible as reviewer.
      await expectCode(
        requestReview(w.executor.ctx(), {
          session_id: sid,
          task_id: t.taskId,
          expected_version: t.version,
          revision: 1,
          reviewer_actor_id: w.executor.id,
        }),
        'action_forbidden',
        'reviewer_is_submitter',
      );
      // A non-member cannot be assigned; a manager cannot be assigned while managers may not review.
      await expectCode(
        requestReview(w.executor.ctx(), {
          session_id: sid,
          task_id: t.taskId,
          expected_version: t.version,
          revision: 1,
          reviewer_actor_id: w.outsider.id,
        }),
        'invalid_request',
        'reviewer_not_eligible',
      );
      await expectCode(
        requestReview(w.executor.ctx(), {
          session_id: sid,
          task_id: t.taskId,
          expected_version: t.version,
          revision: 1,
          reviewer_actor_id: w.manager.id,
        }),
        'invalid_request',
        'reviewer_not_eligible',
      );
      // Allowing manager review makes the manager assignable, and an unassigned manager may then record a verdict.
      await owner('UPDATE sessions SET manager_review_allowed = true WHERE id = $1', [sid]);
      try {
        const r = await requestReviewAs(w, t.taskId, t.version, 1, w.reviewer);
        const done = await verdictAs(w, r.review, t.digest, 'approved', w.manager);
        expect(done.task.state).toBe('done');
        // Neither the owner nor the submitter can approve, even with manager rights.
        const t2 = await taskInReview(w);
        const r2 = await requestReviewAs(w, t2.taskId, t2.version, 1, w.reviewer);
        await owner(
          `UPDATE session_members SET roles = ARRAY['participant','manager'] WHERE session_id = $1 AND actor_id = $2`,
          [sid, w.executor.id],
        );
        try {
          const error = await failure(verdictAs(w, r2.review, t2.digest, 'approved', w.executor));
          expect(error.code).toBe('action_forbidden');
          expect(['reviewer_is_submitter', 'reviewer_is_owner']).toContain(error.details['reason']);
        } finally {
          await owner(
            `UPDATE session_members SET roles = ARRAY['participant'] WHERE session_id = $1 AND actor_id = $2`,
            [sid, w.executor.id],
          );
        }
      } finally {
        await owner('UPDATE sessions SET manager_review_allowed = false WHERE id = $1', [sid]);
      }
      // With the flag off again, an unassigned manager is refused.
      const t3 = await taskInReview(w);
      const r3 = await requestReviewAs(w, t3.taskId, t3.version, 1, w.reviewer);
      await expectCode(
        verdictAs(w, r3.review, t3.digest, 'approved', w.manager),
        'action_forbidden',
        'not_assigned_reviewer',
      );
    });

    it('review.auto_complete.gates: a failed gate leaves the approval standing and the task in review; manager complete finishes it', async () => {
      const t = await taskInReview(w);
      const r = await requestReviewAs(w, t.taskId, t.version, 1);
      await owner(
        `UPDATE work_items SET blocked_reason = 'waiting on infra', blocked_at = now() WHERE id = $1`,
        [t.taskId],
      );
      const approved = await verdictAs(w, r.review, t.digest, 'approved', w.reviewer);
      expect(approved.review.state).toBe('approved');
      expect(approved.task).toEqual({ id: t.taskId, version: r.task_version, state: 'review' });
      await expectCode(
        completeTask(w.manager.ctx(), {
          session_id: sid,
          task_id: t.taskId,
          expected_version: r.task_version,
        }),
        'invalid_transition',
        'blocked',
      );
      await owner('UPDATE work_items SET blocked_reason = NULL, blocked_at = NULL WHERE id = $1', [
        t.taskId,
      ]);
      const done = await completeTask(w.manager.ctx(), {
        session_id: sid,
        task_id: t.taskId,
        expected_version: r.task_version,
      });
      expect(done.state).toBe('done');
    });
  });

  it('complete.truth_table: the manager completes only when the gates pass', async () => {
    const complete = (t: { taskId: Uuid }, version: number) =>
      completeTask(w.manager.ctx(), {
        session_id: sid,
        task_id: t.taskId,
        expected_version: version,
      });
    // review_required = false: done with or without any review.
    const none = await taskInReview(w, { reviewRequired: false });
    expect((await complete(none, none.version)).state).toBe('done');
    const withVerdict = await taskInReview(w, { reviewRequired: false });
    const rv = await requestReviewAs(w, withVerdict.taskId, withVerdict.version, 1);
    await verdictAs(w, rv.review, withVerdict.digest, 'changes_requested', w.reviewer);
    expect((await complete(withVerdict, rv.task_version)).state).toBe('done');
    // review_required = true: no review, requested, changes_requested all refuse.
    const noReview = await taskInReview(w);
    await expectCode(complete(noReview, noReview.version), 'review_required');
    const requested = await taskInReview(w);
    const rq = await requestReviewAs(w, requested.taskId, requested.version, 1);
    await expectCode(complete(requested, rq.task_version), 'review_required');
    const changes = await taskInReview(w);
    const rc = await requestReviewAs(w, changes.taskId, changes.version, 1);
    await verdictAs(w, rc.review, changes.digest, 'changes_requested', w.reviewer);
    await expectCode(complete(changes, rc.task_version), 'review_required');
    // Only reviews of older revisions exist.
    const older = await taskInReview(w);
    const ro = await requestReviewAs(w, older.taskId, older.version, 1);
    await verdictAs(w, ro.review, older.digest, 'changes_requested', w.reviewer);
    const again = await claimAs(w, older.taskId, ro.task_version);
    const rev2 = await submitAs(w, older.taskId, again.version, again.fence, 'second');
    await expectCode(complete(older, rev2.version), 'review_required');
    // A result written under superseded criteria or an earlier work cycle does not count.
    const stale = await taskInReview(w, { reviewRequired: false });
    await owner('UPDATE task_details SET criteria_revision = 2 WHERE item_id = $1', [stale.taskId]);
    await expectCode(complete(stale, stale.version), 'invalid_transition', 'stale_revision');
  });

  it('authz.lifecycle: the item matrix', async () => {
    const task = await newTask(w, { by: w.executor2 }); // any participant may create tasks
    expect(task.owner_actor_id).toBeNull();
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    // Not the owner: owner_conflict, even with a valid role and its own instance.
    await expectCode(
      submitAs(w, task.id as Uuid, claimed.version, claimed.fence, 'x', w.executor2),
      'owner_conflict',
    );
    // A room member outside the session sees nothing.
    await expectCode(
      claim(w.outsider.ctx(), {
        session_id: sid,
        task_id: task.id,
        expected_version: claimed.version,
      }),
      'not_found',
    );
    // complete is a manager action.
    await expectCode(
      completeTask(w.executor.ctx(), {
        session_id: sid,
        task_id: task.id,
        expected_version: claimed.version,
      }),
      'action_forbidden',
    );
    // Claiming requires an agent instance.
    const t2 = await newTask(w);
    const noInstance = f.ctxFor(w.ws, w.executor2.id, uniqueKey(), null);
    await expectCode(
      claim(noInstance, { session_id: sid, task_id: t2.id, expected_version: t2.version }),
      'action_forbidden',
      'instance_required',
    );
    // A verdict must come from the assigned reviewer.
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1, w.reviewer);
    await expectCode(
      verdictAs(w, r.review, t.digest, 'approved', w.reviewer2),
      'action_forbidden',
      'not_assigned_reviewer',
    );
    // Only the owner or a manager can request a review.
    await expectCode(
      requestReview(w.executor2.ctx(), {
        session_id: sid,
        task_id: t.taskId,
        expected_version: r.task_version,
        revision: 1,
        reviewer_actor_id: w.reviewer2.id,
      }),
      'action_forbidden',
      'not_owner',
    );
    // A task addressed through the wrong session is not found.
    const other = await f.session(w.manager);
    await f.join(other, w.executor);
    await expectCode(
      claim(w.executor.ctx(), { session_id: other.id, task_id: task.id, expected_version: 1 }),
      'not_found',
    );
  });

  it('submit.validation', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    const base = {
      session_id: sid,
      task_id: task.id,
      expected_version: claimed.version,
      fence: claimed.fence,
      content: 'ok',
      content_type: 'text/plain',
      criteria_mapping: MAPPING,
    };
    const submit = (over: Record<string, unknown>) =>
      submitResult(w.executor.ctx(), { ...base, ...over });
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
    expect((await failure(submit({ content: 'a'.repeat(262145) }))).details['field']).toBe(
      'content',
    );
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

    const text = '  héllo — 世界 🚀\n  ';
    const result = await submit({
      content: text,
      supporting_refs: [{ url: 'https://example.com/evidence', label: 'ev' }],
    });
    expect(result.byte_length).toBe(Buffer.byteLength(text, 'utf8'));
    const [row] = await owner<{
      content: string;
      content_sha256: string;
      digest_ok: boolean;
      criteria_revision: number;
      work_cycle: number;
    }>(
      `SELECT content, content_sha256, criteria_revision, work_cycle,
              content_sha256 = encode(digest(convert_to(content, 'UTF8'), 'sha256'), 'hex') AS digest_ok
         FROM task_result_revisions WHERE task_id = $1`,
      [task.id],
    );
    expect(row?.content).toBe(text);
    expect(row?.digest_ok).toBe(true);
    expect(row?.content_sha256).toBe(result.content_sha256);
    expect(row).toMatchObject({ criteria_revision: 1, work_cycle: 1 });
    expect(CRITERIA).toHaveLength(2);
  });

  it('idempotency.lifecycle_replay: replays are exact and are re-authorized', async () => {
    const task = await newTask(w);
    const ctxClaim = w.executor.ctx(uniqueKey('claim'));
    const first = await claim(ctxClaim, {
      session_id: sid,
      task_id: task.id,
      expected_version: task.version,
    });
    expect(
      await claim(ctxClaim, { session_id: sid, task_id: task.id, expected_version: task.version }),
    ).toEqual(first);
    expect((await leaseOf(task.id)).fence).toBe(1);

    const ctxSubmit = w.executor.ctx(uniqueKey('submit'));
    const input = {
      session_id: sid,
      task_id: task.id,
      expected_version: first.version,
      fence: first.fence,
      content: 'once',
      content_type: 'text/plain',
      criteria_mapping: MAPPING,
    };
    const s1 = await submitResult(ctxSubmit, input);
    expect(await submitResult(ctxSubmit, input)).toEqual(s1);
    expect(
      await f.count(`SELECT count(*) AS n FROM task_result_revisions WHERE task_id = $1`, [
        task.id,
      ]),
    ).toBe(1);
    await expectCode(
      submitResult(ctxSubmit, { ...input, content: 'twice' }),
      'idempotency_conflict',
    );

    // A removed member cannot fetch a stored result through the replay path.
    const temp = await w.participant();
    const t2 = await newTask(w);
    const ctxTemp = temp.ctx(uniqueKey('rev'));
    const c2 = await claim(ctxTemp, {
      session_id: sid,
      task_id: t2.id,
      expected_version: t2.version,
    });
    await owner(
      'UPDATE session_members SET removed_at = now() WHERE session_id = $1 AND actor_id = $2',
      [sid, temp.id],
    );
    const error = await expectCode(
      claim(ctxTemp, { session_id: sid, task_id: t2.id, expected_version: t2.version }),
      'not_found',
    );
    expect(JSON.stringify(error)).not.toContain(`"fence":${String(c2.fence)}`);
    expect((await leaseOf(t2.id)).fence).toBe(1);
  });

  it('events.one_per_version: contiguous versions, exact payload keys, no content', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    const renewed = await renewLease(w.executor.ctx(), {
      session_id: sid,
      task_id: task.id,
      expected_version: claimed.version,
      fence: claimed.fence,
    });
    await expireLease(task.id);
    const reacquired = await claimAs(w, task.id as Uuid, renewed.version);
    const submitted = await submitAs(w, task.id as Uuid, reacquired.version, reacquired.fence);
    const r = await requestReviewAs(w, task.id as Uuid, submitted.version, 1);
    await verdictAs(w, r.review, submitted.content_sha256, 'approved', w.reviewer);

    const events = await owner<{
      aggregate_id: string;
      aggregate_version: number;
      event_type: string;
      payload: Record<string, unknown>;
      session_id: string;
    }>(
      `SELECT aggregate_id, aggregate_version, event_type, payload, session_id FROM domain_events
        WHERE aggregate_id = ANY($1::uuid[]) ORDER BY aggregate_id, aggregate_version`,
      [[task.id, r.review.id]],
    );
    const by = new Map<string, typeof events>();
    for (const e of events) by.set(e.aggregate_id, [...(by.get(e.aggregate_id) ?? []), e]);
    expect(by.get(task.id)?.map((e) => [e.aggregate_version, e.event_type])).toEqual([
      [1, 'task.created'],
      [2, 'task.claimed'],
      [3, 'task.lease_renewed'],
      [4, 'task.claimed'],
      [5, 'task.result_submitted'],
      [6, 'task.review_requested'],
      [7, 'task.completed'],
    ]);
    expect(by.get(r.review.id)?.map((e) => [e.aggregate_version, e.event_type])).toEqual([
      [1, 'review.requested'],
      [2, 'review.verdict_recorded'],
    ]);
    const KEYS: Record<string, string[]> = {
      'task.created': ['board_id', 'criteria_count', 'review_required', 'shareable', 'title'],
      'task.claimed': ['expires_at', 'fence', 'owner_actor_id', 'reacquired'],
      'task.lease_renewed': ['expires_at', 'fence'],
      'task.result_submitted': [
        'byte_length',
        'content_sha256',
        'content_type',
        'fence',
        'revision',
        'supporting_ref_count',
      ],
      'task.review_requested': ['review_id', 'reviewer_actor_id', 'revision'],
      'review.requested': ['content_sha256', 'reviewer_actor_id', 'revision', 'task_id'],
      'review.verdict_recorded': ['revision', 'task_id', 'verdict'],
      'task.completed': ['review_id', 'revision', 'trigger'],
    };
    for (const e of events) {
      expect(Object.keys(e.payload).sort(), e.event_type).toEqual(KEYS[e.event_type]);
      expect(e.session_id).toBe(sid);
      expect(JSON.stringify(e.payload)).not.toContain('the result');
    }
  });

  it('errors.precedence', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    await expectCode(
      claim(w.outsider.ctx(), { session_id: 'not-a-uuid', task_id: task.id, expected_version: 1 }),
      'invalid_request',
    );
    // 4 not_found beats 5 action_forbidden and 6 version_conflict.
    await expectCode(
      completeTask(w.outsider.ctx(), { session_id: sid, task_id: task.id, expected_version: 99 }),
      'not_found',
    );
    // 5 action_forbidden beats 6 version_conflict (participant calling a manager action with a wrong version).
    await expectCode(
      completeTask(w.executor.ctx(), { session_id: sid, task_id: task.id, expected_version: 99 }),
      'action_forbidden',
    );
    // 6 version_conflict beats 7 invalid_transition.
    await expectCode(
      completeTask(w.manager.ctx(), { session_id: sid, task_id: task.id, expected_version: 99 }),
      'version_conflict',
    );
    await expectCode(
      completeTask(w.manager.ctx(), {
        session_id: sid,
        task_id: task.id,
        expected_version: claimed.version,
      }),
      'invalid_transition',
    );
    // 8 owner_conflict beats 9 lease_conflict.
    await expectCode(
      claim(w.executor2.ctx(), {
        session_id: sid,
        task_id: task.id,
        expected_version: claimed.version,
      }),
      'owner_conflict',
    );
    // 9 lease_lost beats 10 evidence_required.
    await expectCode(
      submitResult(w.executor.ctx(), {
        session_id: sid,
        task_id: task.id,
        expected_version: claimed.version,
        fence: claimed.fence + 5,
        content: 'x',
        content_type: 'text/plain',
        criteria_mapping: [],
      }),
      'lease_lost',
    );
    // 7 invalid_transition beats 8 owner_conflict.
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1);
    await expectCode(
      claim(w.executor2.ctx(), {
        session_id: sid,
        task_id: t.taskId,
        expected_version: r.task_version,
      }),
      'invalid_transition',
      'review_pending',
    );
  });

  it('create_task: any participant creates; the board must belong to the session; review default comes from the session', async () => {
    const other = await f.session(w.manager);
    const asParticipant = await createTask(w.reviewer.ctx(), {
      session_id: sid,
      board_id: w.session.boardId,
      title: 'by a participant',
      acceptance_criteria: ['c'],
    });
    expect(asParticipant.task).toMatchObject({
      review_required: true,
      session_id: sid,
      board_id: w.session.boardId,
      owner_actor_id: null,
      version: 1,
    });
    await expectCode(
      createTask(w.reviewer.ctx(), {
        session_id: sid,
        board_id: other.boardId,
        title: 'wrong board',
        acceptance_criteria: ['c'],
      }),
      'not_found',
    );
    await owner('UPDATE sessions SET default_review_required = false WHERE id = $1', [sid]);
    try {
      const noReview = await createTask(w.reviewer.ctx(), {
        session_id: sid,
        board_id: w.session.boardId,
        title: 'no review',
        acceptance_criteria: ['c'],
      });
      expect(noReview.task.review_required).toBe(false);
      const explicit = await createTask(w.reviewer.ctx(), {
        session_id: sid,
        board_id: w.session.boardId,
        title: 'explicit',
        acceptance_criteria: ['c'],
        review_required: true,
      });
      expect(explicit.task.review_required).toBe(true);
    } finally {
      await owner('UPDATE sessions SET default_review_required = true WHERE id = $1', [sid]);
    }
    // Revision 1 of the criteria is recorded and immutable.
    const [rev] = await owner<{ acceptance_criteria: string[] }>(
      'SELECT acceptance_criteria FROM task_criteria_revisions WHERE task_id = $1 AND criteria_revision = 1',
      [asParticipant.task.id],
    );
    expect(rev?.acceptance_criteria).toEqual(['c']);
    await expect(
      owner('UPDATE task_criteria_revisions SET criteria_revision = 1'),
    ).rejects.toMatchObject({ code: '23000' });
  });
});
