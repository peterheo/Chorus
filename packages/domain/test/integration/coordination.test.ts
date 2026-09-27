import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  completeTask,
  coordinationStatus,
  dismissSuggestion,
  isChorusError,
  linkSuggestion,
  OBJECT_STATUSES,
  recordScan,
  REF_PREFIX,
  rulesV1,
  setSessionPolicy,
  UNSETTLED_STATUSES,
  updateConversationObject,
  type ApplyMessages,
  type ChorusError,
  type CoordinationEngine,
  type CoordObject,
  type Evaluate,
  type ObjectKind,
  type Signal,
  type SourceMessage,
  type Transition,
  type Uuid,
} from '../../src/index.ts';
import { createFixture, type Actor, type Fixture, type SessionSeed } from '../helpers/fixture.ts';
import { claimAs, makeWorld, newTask, submitAs, uniqueKey, type World } from '../helpers/world.ts';

/**
 * CC-2c persistence, commands and RLS against real PostgreSQL as chorus_app. The real engine (CC-2a) is not
 * needed here: a small deterministic fake stands in for it through the injected `ApplyMessages`/`Evaluate`.
 */

// ---------------------------------------------------------------------------------------------------
// The fake engine: "…?" opens a question, "answer Qn" answers it, "decide: …" and "claim: …" record a
// decision or a claim, and "I will …" a commitment. "@i_…" tokens name the targets.
// ---------------------------------------------------------------------------------------------------

function kindOf(text: string): ObjectKind | undefined {
  if (text.endsWith('?')) return 'question';
  if (text.startsWith('decide:')) return 'decision';
  if (text.startsWith('claim:')) return 'claim';
  if (text.startsWith('I will ')) return 'commitment';
  return undefined;
}

const fakeApply: ApplyMessages = (state, messages, ctx) => {
  const objects = new Map(state.objects.map((o) => [o.ref, o]));
  const next = { ...state.next };
  const transitions: Transition[] = [];
  let cursor = state.cursor;
  for (const m of messages) {
    cursor = Math.max(cursor, m.sequence);
    if (ctx.excludeMemberIds.includes(m.sender_member_id)) continue;
    const source = { message_id: m.message_id, sequence: m.sequence };
    const text = m.content.trim();
    const answer = /^answer (Q[1-9][0-9]*)$/.exec(text)?.[1];
    if (answer !== undefined) {
      const question = objects.get(answer);
      if (question?.status !== 'open') continue;
      objects.set(answer, {
        ...question,
        status: 'answered',
        sources: [...question.sources, source],
        touched_seq: m.sequence,
      });
      transitions.push({
        ref: answer,
        from: 'open',
        to: 'answered',
        cause: 'message',
        message_id: m.message_id,
        reason: 'answered in the room',
      });
      continue;
    }
    const kind = kindOf(text);
    if (kind === undefined) continue;
    const prefix = REF_PREFIX[kind];
    const ref = `${prefix}${String(next[prefix])}`;
    next[prefix] += 1;
    const author = { member_id: m.sender_member_id, name: m.sender_name };
    const status = OBJECT_STATUSES[kind][0] ?? 'open';
    const object: CoordObject = {
      ref,
      kind,
      status,
      text,
      author,
      ...(kind === 'commitment' ? { owner: author } : {}),
      targets: [...text.matchAll(/@(i_[A-Za-z0-9]+)/g)].map((t) => ({
        member_id: t[1] ?? '',
        name: t[1] ?? '',
      })),
      related: [],
      sources: [source],
      created_seq: m.sequence,
      touched_seq: m.sequence,
    };
    objects.set(ref, object);
    transitions.push({
      ref,
      from: null,
      to: status,
      cause: 'message',
      message_id: m.message_id,
      reason: `${kind} detected`,
    });
  }
  return { state: { cursor, next, objects: [...objects.values()] }, transitions };
};

/** One `unanswered_question` per open question, and `ready_to_close` once nothing is unsettled. */
const fakeEvaluate: Evaluate = (state) => {
  const unsettled = state.objects.filter((o) => UNSETTLED_STATUSES[o.kind].includes(o.status));
  const signals: Signal[] = unsettled
    .filter((o) => o.kind === 'question')
    .map((o) => ({
      kind: 'unanswered_question',
      refs: [o.ref],
      members: o.targets,
      reason: `${o.ref} has no answer yet.`,
      suggested_next_action: `Answer ${o.ref}.`,
    }));
  if (unsettled.length === 0) {
    signals.push({
      kind: 'ready_to_close',
      refs: [],
      members: [],
      reason: 'Nothing in the conversation is unsettled.',
      suggested_next_action: 'Close the session.',
    });
  }
  return signals;
};

const ENGINE: CoordinationEngine = { apply: fakeApply, excludeMemberIds: [] };

/** The fake engine, but every object comes back as a fresh literal with its keys in reverse order. */
const REBUILDING_ENGINE: CoordinationEngine = {
  apply: (state, messages, ctx) => {
    const result = fakeApply(state, messages, ctx);
    const objects = result.state.objects.map(
      (o) => Object.fromEntries(Object.entries(o).reverse()) as CoordObject,
    );
    return { ...result, state: { ...result.state, objects } };
  },
  excludeMemberIds: [],
};

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

const ALICE = { id: 'i_Alice00001', name: 'alice' };
const BOB = { id: 'i_Bob0000001', name: 'bob' };
const CAROL = { id: 'i_Carol00001', name: 'carol' };
const MANAGER = { id: 'i_Mgr0000001', name: 'manager' };

let seq = 0;
/** One SourceMessage with a globally unique id and a rising sequence (sessions never share a counter's gaps). */
const message = (content: string, from: { id: string; name: string } = ALICE): SourceMessage => {
  seq += 1;
  return {
    message_id: `msg_${String(seq).padStart(5, '0')}`,
    sequence: seq,
    sender_member_id: from.id,
    sender_principal_id: `p_${from.id.slice(2)}`,
    sender_name: from.name,
    content,
    reply_to_message_id: null,
  };
};

async function failure(promise: Promise<unknown>): Promise<ChorusError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isChorusError(error)) throw new Error(`expected a ChorusError, got ${String(error)}`);
  return error;
}

describe('coordination persistence and commands (CC-2c; real PostgreSQL as chorus_app)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture({ poolMax: 16 });
  });
  afterAll(async () => {
    await f.close();
  });

  /** A world whose cast has SharedNet seats: executor = alice, executor2 = bob, reviewer = carol. */
  async function world(label: string): Promise<World> {
    const ws = await f.workspace(`${label}-${randomUUID().slice(0, 8)}`);
    const w = await makeWorld(f, ws);
    const seats: [Actor, string][] = [
      [w.executor, ALICE.id],
      [w.executor2, BOB.id],
      [w.reviewer, CAROL.id],
      [w.manager, MANAGER.id],
    ];
    for (const [actor, member] of seats) {
      await f.owner('UPDATE agent_instances SET sharednet_member_id = $2 WHERE id = $1', [
        actor.instanceId,
        member,
      ]);
    }
    return w;
  }

  const scan = (
    actor: Actor,
    session: SessionSeed,
    msgs: readonly SourceMessage[],
    window: { from?: number; to?: number; key?: string; engine?: CoordinationEngine } = {},
  ) => {
    const from = window.from ?? Math.min(...msgs.map((m) => m.sequence));
    const to = window.to ?? Math.max(...msgs.map((m) => m.sequence));
    return recordScan(actor.ctx(window.key), {
      session_id: session.id,
      from_sequence: from,
      to_sequence: to,
      cutoff_sequence: to,
      messages: msgs,
      extracted: rulesV1.extract(msgs),
      coordination: window.engine ?? ENGINE,
    });
  };

  const objectRows = (session: SessionSeed) =>
    f.owner<{ ref: string; status: string; body: CoordObject; linked_item_id: string | null }>(
      `SELECT ref, status, body, linked_item_id FROM conversation_objects
        WHERE workspace_id = $1 AND session_id = $2 ORDER BY ref`,
      [session.ws.id, session.id],
    );
  const transitionRows = (session: SessionSeed, ref?: string) =>
    f.owner<{
      ref: string;
      from_status: string | null;
      to_status: string;
      cause: string;
      message_id: string | null;
      reason: string;
      actor_id: string | null;
    }>(
      `SELECT ref, from_status, to_status, cause, message_id, reason, actor_id FROM conversation_transitions
        WHERE workspace_id = $1 AND session_id = $2 AND ($3::text IS NULL OR ref = $3)
        ORDER BY created_at, id`,
      [session.ws.id, session.id, ref ?? null],
    );
  const engineState = async (session: SessionSeed) => {
    const [row] = await f.owner<{ cursor: string; next_refs: Record<string, number> }>(
      `SELECT cursor, next_refs FROM conversation_engine_state WHERE workspace_id = $1 AND session_id = $2`,
      [session.ws.id, session.id],
    );
    return row === undefined ? undefined : { cursor: Number(row.cursor), next: row.next_refs };
  };
  const update = (
    actor: Actor,
    session: SessionSeed,
    ref: string,
    action: 'resolve' | 'ignore' | 'reopen',
    key?: string,
  ) => updateConversationObject(actor.ctx(key), { session_id: session.id, ref, action });

  // -------------------------------------------------------------------------------------------------
  // Scan integration
  // -------------------------------------------------------------------------------------------------

  it('a scan persists objects, transitions, the cursor (max sequence) and next_refs', async () => {
    const w = await world('coord-scan');
    const msgs = [
      message('Who owns the release notes?'),
      message('Just a status update.', BOB),
      message(`Can @${BOB.id} check the logs?`),
      message('I will write the changelog.', BOB),
    ];
    const scanned = await scan(w.executor, w.session, msgs);
    expect(scanned.coordination).toEqual({
      applied_messages: 4,
      skipped_before_cursor: 0,
      new_objects: 3,
      transitions: 3,
    });

    const objects = await objectRows(w.session);
    expect(objects.map((o) => [o.ref, o.status])).toEqual([
      ['C1', 'open'],
      ['Q1', 'open'],
      ['Q2', 'open'],
    ]);
    const q2 = objects.find((o) => o.ref === 'Q2');
    expect(q2?.body).toMatchObject({
      kind: 'question',
      author: { member_id: ALICE.id },
      targets: [{ member_id: BOB.id }],
      sources: [{ message_id: msgs[2]?.message_id, sequence: msgs[2]?.sequence }],
    });
    const transitions = await transitionRows(w.session);
    expect(transitions).toHaveLength(3);
    expect(transitions.every((t) => t.cause === 'message' && t.from_status === null)).toBe(true);
    expect(transitions.every((t) => t.actor_id === w.executor.id)).toBe(true);

    expect(await engineState(w.session)).toEqual({
      cursor: msgs[3]?.sequence,
      next: { Q: 3, C: 2, H: 1, D: 1, K: 1, X: 1, P: 1 },
    });
  });

  it('rescanning the same window applies nothing and adds no objects or transitions', async () => {
    const w = await world('coord-rescan');
    const msgs = [message('Where is the runbook?'), message('Is staging up?')];
    await scan(w.executor, w.session, msgs);
    const before = { objects: await objectRows(w.session), state: await engineState(w.session) };
    const transitions = (await transitionRows(w.session)).length;

    const again = await scan(w.executor, w.session, msgs);
    expect(again.coordination).toEqual({
      applied_messages: 0,
      skipped_before_cursor: 2,
      new_objects: 0,
      transitions: 0,
    });
    expect(await objectRows(w.session)).toEqual(before.objects);
    expect(await engineState(w.session)).toEqual(before.state);
    expect(await transitionRows(w.session)).toHaveLength(transitions);
  });

  it('an older window scanned after a newer one is skipped entirely and changes nothing', async () => {
    const w = await world('coord-older');
    const msgs = [
      message('What is the old question?'),
      message('Was this ever asked?'),
      message('Which region is primary?'),
      message('Who is on call?'),
    ];
    const [m1, m2, m3, m4] = msgs.map((m) => m.sequence);
    if (m1 === undefined || m2 === undefined || m3 === undefined || m4 === undefined)
      throw new Error('expected four messages');
    const newer = await scan(w.executor, w.session, msgs, { from: m3, to: m4 });
    expect(newer.coordination).toMatchObject({ applied_messages: 2, new_objects: 2 });
    const before = {
      objects: await objectRows(w.session),
      transitions: await transitionRows(w.session),
      state: await engineState(w.session),
    };
    expect(before.state?.cursor).toBe(m4);

    const older = await scan(w.executor, w.session, msgs, { from: m1, to: m2 });
    expect(older.coordination).toEqual({
      applied_messages: 0,
      skipped_before_cursor: 2,
      new_objects: 0,
      transitions: 0,
    });
    expect(await objectRows(w.session)).toEqual(before.objects);
    expect(await transitionRows(w.session)).toEqual(before.transitions);
    expect(await engineState(w.session)).toEqual(before.state);
  });

  it("a later message moves an existing object: the row is updated and a 'message' transition appended", async () => {
    const w = await world('coord-later');
    const ask = message('Which database version do we target?');
    await scan(w.executor, w.session, [ask]);
    const reply = message('answer Q1', BOB);
    const later = await scan(w.executor2, w.session, [reply]);
    expect(later.coordination).toEqual({
      applied_messages: 1,
      skipped_before_cursor: 0,
      new_objects: 0,
      transitions: 1,
    });

    const [q1] = await objectRows(w.session);
    expect(q1?.status).toBe('answered');
    expect(q1?.body.status).toBe('answered');
    expect(q1?.body.touched_seq).toBe(reply.sequence);
    expect(q1?.body.sources.map((s) => s.message_id)).toEqual([ask.message_id, reply.message_id]);
    const transitions = await transitionRows(w.session, 'Q1');
    expect(transitions.map((t) => [t.from_status, t.to_status, t.cause, t.message_id])).toEqual([
      [null, 'open', 'message', ask.message_id],
      ['open', 'answered', 'message', reply.message_id],
    ]);
    expect(transitions[1]?.actor_id).toBe(w.executor2.id);
  });

  it('an unchanged object the engine rebuilds with another key order is not rewritten', async () => {
    const w = await world('coord-rebuild');
    await scan(w.executor, w.session, [message(`Can @${BOB.id} check the logs?`)]);
    const q1Row = () =>
      f.owner<{ body: CoordObject; updated_at: Date }>(
        `SELECT body, updated_at FROM conversation_objects
          WHERE workspace_id = $1 AND session_id = $2 AND ref = 'Q1'`,
        [w.ws.id, w.session.id],
      );
    const [before] = await q1Row();

    const next = await scan(w.executor, w.session, [message('Is this a new question?')], {
      engine: REBUILDING_ENGINE,
    });
    expect(next.coordination).toEqual({
      applied_messages: 1,
      skipped_before_cursor: 0,
      new_objects: 1,
      transitions: 1,
    });
    const [after] = await q1Row();
    expect(after?.updated_at).toEqual(before?.updated_at);
    expect(after?.body).toEqual(before?.body);
    expect(await transitionRows(w.session, 'Q1')).toHaveLength(1);
    expect((await objectRows(w.session)).map((o) => o.ref)).toEqual(['Q1', 'Q2']);
  });

  // -------------------------------------------------------------------------------------------------
  // CC-1 link/dismiss sync
  // -------------------------------------------------------------------------------------------------

  it("linking a suggestion records the task on its object with a 'command' transition; dismissing dismisses it", async () => {
    const w = await world('coord-link');
    const msgs = [
      message('Can someone check why the deploy fails?'),
      message('Can someone review the migration plan?'),
    ];
    const scanned = await scan(w.executor, w.session, msgs);
    const refs = await f.owner<{ id: Uuid; object_ref: string | null; source_message_id: string }>(
      `SELECT id, object_ref, source_message_id FROM conversation_suggestions
        WHERE workspace_id = $1 AND session_id = $2 ORDER BY source_sequence`,
      [w.ws.id, w.session.id],
    );
    expect(scanned.suggestions).toHaveLength(2);
    expect(refs.map((r) => [r.source_message_id, r.object_ref])).toEqual([
      [msgs[0]?.message_id, 'Q1'],
      [msgs[1]?.message_id, 'Q2'],
    ]);
    const [toLink, toDismiss] = refs;
    if (toLink === undefined || toDismiss === undefined) throw new Error('expected suggestions');

    const task = await newTask(w, { by: w.executor });
    await linkSuggestion(w.executor.ctx(), {
      session_id: w.session.id,
      suggestion_id: toLink.id,
      item_id: task.id as Uuid,
    });
    let objects = await objectRows(w.session);
    const q1 = objects.find((o) => o.ref === 'Q1');
    expect(q1?.linked_item_id).toBe(task.id);
    expect(q1?.body.linked_item_id).toBe(task.id);
    expect(q1?.status).toBe('open');
    expect(
      (await transitionRows(w.session, 'Q1')).map((t) => [t.from_status, t.to_status, t.cause]),
    ).toEqual([
      [null, 'open', 'message'],
      ['open', 'open', 'command'],
    ]);

    await dismissSuggestion(w.executor.ctx(), {
      session_id: w.session.id,
      suggestion_id: toDismiss.id,
    });
    objects = await objectRows(w.session);
    const q2 = objects.find((o) => o.ref === 'Q2');
    expect(q2?.status).toBe('dismissed');
    expect(q2?.body.status).toBe('dismissed');
    const last = (await transitionRows(w.session, 'Q2')).at(-1);
    expect(last).toMatchObject({
      from_status: 'open',
      to_status: 'dismissed',
      cause: 'command',
      actor_id: w.executor.id,
    });
  });

  // -------------------------------------------------------------------------------------------------
  // updateConversationObject
  // -------------------------------------------------------------------------------------------------

  it('update_conversation_object: involvement, manager override, ignore, reopen, kinds, not_found and replay', async () => {
    const w = await world('coord-update');
    await scan(w.executor, w.session, [
      message(`Can @${BOB.id} check the logs?`),
      message('Where is the runbook?'),
      message('decide: we ship on Friday'),
      message('claim: the cache is cold'),
    ]);

    // A target (bob) resolves Q1.
    const resolved = await update(w.executor2, w.session, 'Q1', 'resolve');
    expect(resolved.object).toMatchObject({ ref: 'Q1', status: 'answered' });
    expect((await transitionRows(w.session, 'Q1')).at(-1)).toMatchObject({
      from_status: 'open',
      to_status: 'answered',
      cause: 'command',
      message_id: null,
      reason: 'resolve',
      actor_id: w.executor2.id,
    });

    // A participant who is neither author, owner nor target cannot touch Q2.
    const forbidden = await failure(update(w.reviewer, w.session, 'Q2', 'resolve'));
    expect(forbidden.code).toBe('action_forbidden');
    expect(forbidden.details).toMatchObject({ reason: 'not_involved' });
    // An actor with no seat at all is not involved either.
    const seatless = await w.participant('seatless');
    expect((await failure(update(seatless, w.session, 'Q2', 'ignore'))).details).toMatchObject({
      reason: 'not_involved',
    });

    // A manager can act on anything: ignore → dismissed.
    const ignored = await update(w.manager, w.session, 'Q2', 'ignore');
    expect(ignored.object.status).toBe('dismissed');

    // The author reopens it from the terminal status → the initial status; reopening it again is refused.
    const reopened = await update(w.executor, w.session, 'Q2', 'reopen');
    expect(reopened.object.status).toBe('open');
    const stillOpen = await failure(update(w.executor, w.session, 'Q2', 'reopen'));
    expect(stillOpen.code).toBe('invalid_transition');
    expect(stillOpen.details).toMatchObject({ reason: 'not_terminal', state: 'open' });

    // Decisions and claims have no resolved status.
    for (const ref of ['D1', 'K1']) {
      const error = await failure(update(w.executor, w.session, ref, 'resolve'));
      expect(error.code).toBe('invalid_transition');
      expect(error.details).toMatchObject({ reason: 'not_resolvable' });
    }

    // An unknown ref.
    expect((await failure(update(w.executor, w.session, 'Q99', 'resolve'))).code).toBe('not_found');

    // A replay with the same idempotency key returns the stored result and records nothing more.
    const key = uniqueKey('upd');
    const first = await update(w.executor, w.session, 'Q2', 'resolve', key);
    const count = (await transitionRows(w.session, 'Q2')).length;
    const replay = await update(w.executor, w.session, 'Q2', 'resolve', key);
    expect(replay).toEqual(first);
    expect(first.object.status).toBe('answered');
    expect(await transitionRows(w.session, 'Q2')).toHaveLength(count);

    const [q2] = (await objectRows(w.session)).filter((o) => o.ref === 'Q2');
    expect(q2?.status).toBe('answered');
    expect(q2?.body.status).toBe('answered');
  });

  // -------------------------------------------------------------------------------------------------
  // coordinationStatus
  // -------------------------------------------------------------------------------------------------

  it('coordination_status: membership, open-only filtering, include_closed, and ready_to_close gated on tasks', async () => {
    const w = await world('coord-status');
    await expect(
      coordinationStatus(f.readCtx(w.outsider), { session_id: w.session.id }, fakeEvaluate),
    ).rejects.toMatchObject({ code: 'not_found' });

    const msgs = [message('Where is the runbook?'), message('Is staging up?')];
    await scan(w.executor, w.session, msgs);
    await update(w.executor, w.session, 'Q1', 'resolve');

    const status = await coordinationStatus(
      f.readCtx(w.reviewer),
      { session_id: w.session.id },
      fakeEvaluate,
    );
    expect(status.inferred).toBe(true);
    expect(status.coverage).toBe('scanned_windows_only');
    expect(status.cursor).toBe(msgs[1]?.sequence);
    expect(status.objects['questions']?.map((o) => o.ref)).toEqual(['Q2']);
    expect(status.objects['decisions']).toEqual([]);
    expect(status.signals.map((s) => [s.kind, s.refs])).toEqual([['unanswered_question', ['Q2']]]);
    expect(status.ready_to_close).toBe(false);

    const all = await coordinationStatus(
      f.readCtx(w.reviewer),
      { session_id: w.session.id, include_closed: true },
      fakeEvaluate,
    );
    expect(all.objects['questions']?.map((o) => [o.ref, o.status])).toEqual([
      ['Q1', 'answered'],
      ['Q2', 'open'],
    ]);

    // Nothing unsettled in the conversation, but an unfinished task: ready_to_close is withheld.
    const task = await newTask(w, { reviewRequired: false });
    await update(w.executor, w.session, 'Q2', 'ignore');
    const blocked = await coordinationStatus(
      f.readCtx(w.executor),
      { session_id: w.session.id },
      fakeEvaluate,
    );
    expect(blocked.signals).toEqual([]);
    expect(blocked.ready_to_close).toBe(false);

    // Once every task is done, it is surfaced.
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    const submitted = await submitAs(w, task.id as Uuid, claimed.version, claimed.fence);
    const done = await completeTask(w.manager.ctx(), {
      session_id: w.session.id,
      task_id: task.id,
      expected_version: submitted.version,
    });
    expect(done.state).toBe('done');
    const ready = await coordinationStatus(
      f.readCtx(w.executor),
      { session_id: w.session.id },
      fakeEvaluate,
    );
    expect(ready.ready_to_close).toBe(true);
    expect(ready.signals.map((s) => s.kind)).toEqual(['ready_to_close']);
  });

  // -------------------------------------------------------------------------------------------------
  // RLS and the session coordination mode
  // -------------------------------------------------------------------------------------------------

  it("RLS: session B's coordination rows are invisible to a member of A; coordination_mode changes only through set_session_policy", async () => {
    const w = await world('coord-rls');
    const bOwner = await f.actor(w.ws, 'coord-rls-b');
    const sessionB = await f.session(bOwner);
    await scan(bOwner, sessionB, [message('Is B private?'), message('answer Q1')]);
    await scan(w.executor, w.session, [message('Is A visible?')]);

    const asChorusApp = async <T>(
      actor: Actor,
      fn: (query: (sql: string, params?: unknown[]) => Promise<unknown[]>) => Promise<T>,
    ): Promise<T> => {
      const client = await f.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
          [w.ws.id, actor.id],
        );
        return await fn(
          async (sql, params) => (await client.query<Record<string, unknown>>(sql, params)).rows,
        );
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    const tables = [
      'conversation_objects',
      'conversation_transitions',
      'conversation_engine_state',
    ];
    await asChorusApp(w.executor, async (query) => {
      for (const table of tables) {
        expect(await query(`SELECT * FROM ${table} WHERE session_id = $1`, [sessionB.id])).toEqual(
          [],
        );
        // Control: A's own rows are visible.
        expect(
          (await query(`SELECT * FROM ${table} WHERE session_id = $1`, [w.session.id])).length,
        ).toBeGreaterThan(0);
      }
    });
    await asChorusApp(bOwner, async (query) => {
      for (const table of tables) {
        expect(
          (await query(`SELECT * FROM ${table} WHERE session_id = $1`, [sessionB.id])).length,
        ).toBeGreaterThan(0);
      }
    });

    // Not even an administrator can UPDATE the column directly: chorus_app has no UPDATE on sessions.
    await expect(
      asChorusApp(w.manager, (query) =>
        query(`UPDATE sessions SET coordination_mode = 'assist' WHERE id = $1`, [w.session.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const mode = async () =>
      (
        await f.owner<{ coordination_mode: string }>(
          'SELECT coordination_mode FROM sessions WHERE id = $1',
          [w.session.id],
        )
      )[0]?.coordination_mode;
    expect(await mode()).toBe('off');

    // A participant (not an administrator) is refused.
    const refused = await failure(
      setSessionPolicy(w.executor.ctx(), {
        session_id: w.session.id,
        expected_version: 2,
        coordination_mode: 'assist',
      }),
    );
    expect(refused.code).toBe('action_forbidden');
    expect(await mode()).toBe('off');

    // The administrator changes it through the command path.
    const changed = await setSessionPolicy(w.manager.ctx(), {
      session_id: w.session.id,
      expected_version: 2,
      coordination_mode: 'observe',
    });
    expect(changed.changed).toEqual(['coordination_mode']);
    expect(await mode()).toBe('observe');

    // An invalid value: refused by validation on the command path, and by the column CHECK underneath it.
    const invalid = await failure(
      setSessionPolicy(w.manager.ctx(), {
        session_id: w.session.id,
        expected_version: changed.version,
        coordination_mode: 'loud',
      }),
    );
    expect(invalid.code).toBe('invalid_request');
    await expect(
      asChorusApp(w.manager, (query) =>
        query('SELECT chorus_session_set_policy($1, $2::jsonb)', [
          w.session.id,
          JSON.stringify({ coordination_mode: 'loud' }),
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await mode()).toBe('observe');
  });

  it('append-only: objects cannot be deleted and transitions cannot be changed or deleted, even by the owner', async () => {
    const w = await world('coord-append');
    await scan(w.executor, w.session, [message('Can this be erased?')]);
    const params = [w.ws.id, w.session.id];
    const immutable = { code: '23000' };
    await expect(
      f.owner(
        'DELETE FROM conversation_objects WHERE workspace_id = $1 AND session_id = $2',
        params,
      ),
    ).rejects.toMatchObject(immutable);
    await expect(
      f.owner(
        'DELETE FROM conversation_transitions WHERE workspace_id = $1 AND session_id = $2',
        params,
      ),
    ).rejects.toMatchObject(immutable);
    await expect(
      f.owner(
        `UPDATE conversation_transitions SET reason = 'rewritten' WHERE workspace_id = $1 AND session_id = $2`,
        params,
      ),
    ).rejects.toMatchObject(immutable);
    expect(await objectRows(w.session)).toHaveLength(1);
    expect((await transitionRows(w.session))[0]?.reason).toBe('question detected');
  });
});
