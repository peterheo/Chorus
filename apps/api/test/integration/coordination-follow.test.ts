import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApplyMessages,
  CoordObject,
  Evaluate,
  Member,
  ObjectKind,
  RefPrefix,
  Signal,
  SignalKind,
  Transition,
} from '@chorus/domain';
import { REF_PREFIX } from '@chorus/domain';
import { keyUuid, POSTABLE_KINDS, signalKey } from '../../src/coordination-follow.ts';
import { SharedNetClient } from '../../src/sharednet/client.ts';
import { RoomWatcher } from '../../src/watcher.ts';
import {
  SEAT_MEMBER,
  SEAT_PRINCIPAL,
  SHAREDNET_ROOM,
  startStack,
  type Stack,
} from '../helpers/stack.ts';

/**
 * CC-2d (spec §10) follow + assist posting, with a small deterministic fake engine standing in for CC-2a:
 * `raise <signal kind> <text>` creates one object that raises that signal while active; `settle <ref>` ends it.
 * An object whose text is POISON makes `apply` throw (the failure-isolation probe).
 */
const OBJECT_KIND: Record<SignalKind, ObjectKind> = {
  conflict: 'conflict',
  decision_contradicted: 'claim',
  duplicate_commitments: 'commitment',
  dependency_resolved: 'dependency',
  dependency_deadlock: 'dependency',
  unanswered_question: 'question',
  missing_acknowledgement: 'handoff',
  stale_commitment: 'commitment',
  ready_to_close: 'decision',
};
const ALL_KINDS = Object.keys(OBJECT_KIND) as SignalKind[];
const ORDER = [...POSTABLE_KINDS, ...ALL_KINDS.filter((k) => !POSTABLE_KINDS.includes(k))];

function fakeEngine() {
  const calls = { apply: 0, applied: 0, roster: undefined as readonly Member[] | undefined };
  const apply: ApplyMessages = (state, messages, ctx) => {
    calls.apply += 1;
    calls.roster = ctx.roster;
    if (state.objects.some((o) => o.text === 'POISON')) throw new Error('poisoned engine state');
    const objects = state.objects.map((o) => ({ ...o }));
    const next: Record<RefPrefix, number> = { ...state.next };
    const transitions: Transition[] = [];
    let cursor = state.cursor;
    for (const m of messages) {
      if (m.sequence <= cursor) continue;
      cursor = m.sequence;
      if (ctx.excludeMemberIds.includes(m.sender_member_id)) continue;
      calls.applied += 1;
      const raise = /^raise (\w+) (.+)$/.exec(m.content);
      const settle = /^settle (\w+)$/.exec(m.content);
      const kind = raise?.[1] as SignalKind | undefined;
      if (kind !== undefined && raise?.[2] !== undefined && kind in OBJECT_KIND) {
        const prefix = REF_PREFIX[OBJECT_KIND[kind]];
        const ref = `${prefix}${String(next[prefix])}`;
        next[prefix] += 1;
        objects.push({
          ref,
          kind: OBJECT_KIND[kind],
          status: 'active',
          text: raise[2],
          predicate: kind,
          author: { member_id: m.sender_member_id, name: m.sender_name },
          targets: [],
          related: [],
          sources: [{ message_id: m.message_id, sequence: m.sequence }],
          created_seq: m.sequence,
          touched_seq: m.sequence,
        } satisfies CoordObject);
        transitions.push({ ref, from: null, to: 'active', cause: 'message', reason: 'raised' });
      }
      const target = objects.find((o) => o.ref === settle?.[1]);
      if (target !== undefined) {
        objects[objects.indexOf(target)] = {
          ...target,
          status: 'settled',
          touched_seq: m.sequence,
        };
        transitions.push({
          ref: target.ref,
          from: 'active',
          to: 'settled',
          cause: 'message',
          reason: 'settled',
        });
      }
    }
    return { state: { cursor, next, objects }, transitions };
  };
  const evaluate: Evaluate = (state) =>
    state.objects
      .filter((o) => o.status === 'active')
      .map((o): Signal => ({
        kind: o.predicate as SignalKind,
        refs: [o.ref],
        members: [o.author],
        reason: 'fake',
        suggested_next_action: `${o.author.name} flagged "${o.text}" (${o.ref}).`,
      }))
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return { apply, evaluate, calls };
}

describe('coordination follow + assist posting (real PostgreSQL, fake SharedNet, fake engine)', () => {
  let s: Stack;
  let engine: ReturnType<typeof fakeEngine>;
  let clock: number;
  let warnings: { obj: Record<string, unknown>; msg: string }[];
  const watchers: RoomWatcher[] = [];
  beforeEach(async () => {
    s = await startStack({ watch: false });
    engine = fakeEngine();
    clock = Date.parse('2026-09-27T12:00:00Z');
    warnings = [];
  });
  afterEach(async () => {
    for (const w of watchers.splice(0)) await w.stop();
    await s.stop();
  });

  const start = async (withEngine = true): Promise<RoomWatcher> => {
    const w = new RoomWatcher({
      pool: s.pool,
      secretsKey: s.secretsKey,
      client: new SharedNetClient({ baseUrl: s.fake.url, timeoutMs: 5000 }),
      rescanMs: 100,
      expireMs: 30_000,
      minPollIntervalMs: 10,
      maxBackoffMs: 200,
      ...(withEngine ? { coordination: { apply: engine.apply, evaluate: engine.evaluate } } : {}),
      now: () => clock,
      logger: { info: () => undefined, warn: (obj, msg) => warnings.push({ obj, msg }) },
    });
    watchers.push(w);
    await w.start();
    return w;
  };
  const stopAll = async () => {
    for (const w of watchers.splice(0)) await w.stop();
  };
  const head = () => s.fake.rooms.get(SHAREDNET_ROOM)?.messages.at(-1)?.sequence ?? 0;
  /** Waits until the watcher has consumed everything, including its own posts (a post adds a message). */
  const settle = () =>
    s.waitFor('the watcher to catch up', async () => {
      const [row] = await s.owner<{ last_sequence: string }>(
        'SELECT last_sequence FROM sharednet_cursors WHERE room_id = $1',
        [s.roomId],
      );
      return Number(row?.last_sequence ?? -1) >= head();
    });
  let people = 0;
  const say = (name: string, content: string) => {
    const id = name.replace(/[^A-Za-z]/g, '').padEnd(6, 'x');
    return s.fake.post(SHAREDNET_ROOM, {
      memberId: `i_${id}`,
      principalId: `p_${id}`,
      name,
      content,
    });
  };
  const chatter = (n: number) => {
    for (let i = 0; i < n; i++) say('bob', `just chatting, message ${String(i)}`);
  };

  /** A non-discoverable session with one live administrator (who is a live room member), in `mode`. */
  const session = async (
    mode: 'off' | 'observe' | 'assist',
    name = `session ${String(++people)}`,
  ) => {
    const [actor] = await s.owner<{ id: string }>(
      `INSERT INTO actors (workspace_id, kind, display_name) VALUES ($1, 'agent', $2) RETURNING id`,
      [s.workspaceId, `admin ${String(people)}`],
    );
    const adminId = actor?.id ?? '';
    await s.owner(
      'INSERT INTO room_members (workspace_id, room_id, actor_id) VALUES ($1, $2, $3)',
      [s.workspaceId, s.roomId, adminId],
    );
    const [row] = await s.owner<{ id: string }>(
      `INSERT INTO sessions (workspace_id, room_id, name, discoverable, created_by, coordination_mode)
       VALUES ($1, $2, $3, false, $4, $5) RETURNING id`,
      [s.workspaceId, s.roomId, name, adminId, mode],
    );
    const id = row?.id ?? '';
    await s.owner(
      `INSERT INTO session_members (workspace_id, session_id, actor_id, roles)
       VALUES ($1, $2, $3, ARRAY['participant', 'manager', 'administrator'])`,
      [s.workspaceId, id, adminId],
    );
    const [board] = await s.owner<{ id: string }>(
      'INSERT INTO projects (workspace_id, session_id, name) VALUES ($1, $2, $3) RETURNING id',
      [s.workspaceId, id, 'Board'],
    );
    return { id, adminId, boardId: board?.id ?? '' };
  };
  const objects = (sessionId: string) =>
    s.owner<{ ref: string; status: string; body: CoordObject }>(
      'SELECT ref, status, body FROM conversation_objects WHERE session_id = $1 ORDER BY created_seq, ref',
      [sessionId],
    );
  const engineCursor = async (sessionId: string) =>
    (
      await s.owner<{ cursor: string }>(
        'SELECT cursor FROM conversation_engine_state WHERE session_id = $1',
        [sessionId],
      )
    )[0]?.cursor;
  const posted = (sessionId: string) =>
    s.owner<{ signal_key: string; message_id: string }>(
      'SELECT signal_key, message_id FROM conversation_posts WHERE session_id = $1 ORDER BY signal_key',
      [sessionId],
    );
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('follow: applies each new message exactly once, skips the seat, and survives redelivery and restarts', async () => {
    const a = await session('observe');
    await start();
    say('alice', 'raise unanswered_question who owns the deploy?');
    s.fake.post(SHAREDNET_ROOM, {
      memberId: SEAT_MEMBER,
      principalId: SEAT_PRINCIPAL,
      content: 'raise conflict the seat must never be applied',
    });
    say('bob', 'raise stale_commitment I will write the docs');
    await settle();
    expect((await objects(a.id)).map((o) => [o.ref, o.body.text])).toEqual([
      ['Q1', 'who owns the deploy?'],
      ['C1', 'I will write the docs'],
    ]);
    expect(Number(await engineCursor(a.id))).toBe(3);
    expect(engine.calls.applied).toBe(2);
    // The engine gets the room's roster: every sender seen, never the Chorus seat.
    expect(engine.calls.roster).toEqual(
      expect.arrayContaining([
        { member_id: 'i_alicex', name: 'alice' },
        { member_id: 'i_bobxxx', name: 'bob' },
      ]),
    );
    expect(engine.calls.roster?.some((m) => m.member_id === SEAT_MEMBER)).toBe(false);
    const transitions = async () =>
      Number(
        (
          await s.owner<{ n: string }>(
            'SELECT count(*) AS n FROM conversation_transitions WHERE session_id = $1 AND actor_id IS NULL',
            [a.id],
          )
        )[0]?.n,
      );
    expect(await transitions()).toBe(2);

    // Redelivery: an operator rewinds the room cursor and a NEW watcher replays everything. Nothing is re-applied.
    await stopAll();
    await s.owner('UPDATE sharednet_cursors SET last_sequence = 0 WHERE room_id = $1', [s.roomId]);
    await start();
    await settle();
    expect(engine.calls.applied).toBe(2);
    expect(await transitions()).toBe(2);
    expect((await objects(a.id)).length).toBe(2);

    say('carol', 'settle Q1');
    await settle();
    expect((await objects(a.id)).find((o) => o.ref === 'Q1')?.status).toBe('settled');
    expect(Number(await engineCursor(a.id))).toBe(4);
    // Observe mode posts nothing, even with signals due.
    expect(s.fake.sent).toEqual([]);
  });

  it('off: zero ingestion and zero posts; observe: ingestion and zero posts; no engine: follow does nothing', async () => {
    const off = await session('off');
    const observe = await session('observe');
    await start(false);
    say('alice', 'raise conflict caching is on');
    await settle();
    expect(engine.calls.apply).toBe(0);
    expect(await engineCursor(observe.id)).toBeUndefined();
    await stopAll();

    await start();
    say('alice', 'raise conflict caching is off');
    await settle();
    expect(await engineCursor(off.id)).toBeUndefined();
    expect(await objects(off.id)).toEqual([]);
    expect((await objects(observe.id)).map((o) => o.body.text)).toEqual(['caching is off']);
    expect(s.fake.sent).toEqual([]);
    expect(await posted(observe.id)).toEqual([]);
  });

  it('failure isolation: a throwing session is logged and skipped; other sessions and enrollment go on', async () => {
    const poisoned = await session('assist');
    const healthy = await session('observe');
    await s.owner(
      `INSERT INTO conversation_engine_state (workspace_id, session_id, cursor) VALUES ($1, $2, 0)`,
      [s.workspaceId, poisoned.id],
    );
    const body: CoordObject = {
      ref: 'K1',
      kind: 'claim',
      status: 'active',
      text: 'POISON',
      author: { member_id: 'i_someone', name: 'someone' },
      targets: [],
      related: [],
      sources: [{ message_id: 'm0', sequence: 1 }],
      created_seq: 1,
      touched_seq: 1,
    };
    await s.owner(
      `INSERT INTO conversation_objects (workspace_id, session_id, ref, kind, status, body, created_seq, touched_seq)
       VALUES ($1, $2, 'K1', 'claim', 'active', $3::jsonb, 1, 1)`,
      [s.workspaceId, poisoned.id, JSON.stringify(body)],
    );
    await start();
    const agent = s.agent('enrollee');
    const started = await s.startEnrollment(agent);
    say('alice', 'raise conflict the API is stable');
    s.post(agent, started.message);
    await settle();

    expect((await objects(healthy.id)).map((o) => o.body.text)).toEqual(['the API is stable']);
    expect(Number(await engineCursor(poisoned.id))).toBe(0);
    expect((await objects(poisoned.id)).map((o) => o.ref)).toEqual(['K1']);
    const [enrollment] = await s.owner<{ state: string }>(
      'SELECT state FROM enrollments WHERE id = $1',
      [started.enrollmentId],
    );
    expect(enrollment?.state).toBe('verified');
    expect(warnings).toContainEqual({
      obj: { room_id: s.roomId, session_id: poisoned.id, error: 'Error' },
      msg: 'coordination follow failed; session skipped',
    });
    expect(s.fake.sent).toEqual([]);

    // The healthy session keeps following on the next page, and the watcher is still consuming the room.
    say('bob', 'raise conflict the API is unstable');
    await settle();
    expect((await objects(healthy.id)).length).toBe(2);
  });

  it('assist: posts only the five kinds, merged up to 4 lines, once each, with the exact format', async () => {
    const a = await session('assist');
    await start();
    const sources = new Map<SignalKind, { id: string; sequence: number }>();
    for (const kind of [...ALL_KINDS].reverse())
      sources.set(kind, say('alice', `raise ${kind} topic ${kind}`));
    await settle();

    expect(s.fake.sent).toHaveLength(1);
    const first = s.fake.sent[0];
    const lines = first?.content.split('\n') ?? [];
    // Raised in reverse order, so the second commitment and dependency are C2 and P2.
    const refs: [SignalKind, string][] = [
      ['conflict', 'X1'],
      ['decision_contradicted', 'K1'],
      ['duplicate_commitments', 'C2'],
      ['dependency_resolved', 'P2'],
    ];
    expect(lines).toEqual(
      refs.map(([kind, ref]) => {
        const seq = sources.get(kind)?.sequence ?? 0;
        return `[chorus] alice flagged "topic ${kind}" (${ref}). (refs: ${String(seq)})`;
      }),
    );
    // The reply points at the latest source message among the merged signals.
    const latest = Math.max(
      ...['conflict', 'decision_contradicted', 'duplicate_commitments', 'dependency_resolved'].map(
        (k) => sources.get(k as SignalKind)?.sequence ?? 0,
      ),
    );
    expect(first?.replyTo).toBe(
      s.fake.rooms.get(SHAREDNET_ROOM)?.messages.find((m) => m.sequence === latest)?.id,
    );
    expect(first?.idempotencyKey).toMatch(UUID_V4);
    const keys = (await posted(a.id)).map((r) => r.signal_key);
    expect(keys).toEqual(
      [
        signalKey(a.id, 'conflict', ['X1']),
        signalKey(a.id, 'decision_contradicted', ['K1']),
        signalKey(a.id, 'duplicate_commitments', ['C2']),
        signalKey(a.id, 'dependency_resolved', ['P2']),
      ].sort(),
    );

    // dependency_deadlock is due but needs 8 non-Chorus messages since the last post.
    chatter(7);
    await settle();
    expect(s.fake.sent).toHaveLength(1);
    chatter(1);
    await settle();
    expect(s.fake.sent).toHaveLength(2);
    const deadlockKey = signalKey(a.id, 'dependency_deadlock', ['P1']);
    expect(s.fake.sent[1]?.content).toBe(
      `[chorus] alice flagged "topic dependency_deadlock" (P1). (refs: ${String(sources.get('dependency_deadlock')?.sequence)})`,
    );
    expect(s.fake.sent[1]?.idempotencyKey).toBe(keyUuid(deadlockKey));
    expect((await posted(a.id)).map((r) => r.signal_key)).toContain(deadlockKey);

    // Every postable signal is recorded; the four others never are, however long the room goes on.
    chatter(20);
    await settle();
    expect(s.fake.sent).toHaveLength(2);
    expect(await posted(a.id)).toHaveLength(5);
    for (const sent of s.fake.sent) {
      for (const kind of [
        'unanswered_question',
        'missing_acknowledgement',
        'stale_commitment',
        'ready_to_close',
      ])
        expect(sent.content).not.toContain(kind);
    }
  });

  it('assist: the same signal is never posted twice, across watcher restarts and redelivery', async () => {
    const a = await session('assist');
    await start();
    say('alice', 'raise conflict the cache is warm');
    await settle();
    expect(s.fake.sent).toHaveLength(1);

    await stopAll();
    await s.owner('UPDATE sharednet_cursors SET last_sequence = 0 WHERE room_id = $1', [s.roomId]);
    await start(); // fresh in-memory state: only the recorded keys stand between the room and a repost
    chatter(10);
    await settle();
    expect(s.fake.sent).toHaveLength(1);
    expect(await posted(a.id)).toHaveLength(1);
  });

  it('assist: a failed send records nothing and is retried on the next step', async () => {
    const a = await session('assist');
    await start();
    s.fake.postFailWith = 503;
    say('alice', 'raise conflict retries are cheap');
    await settle();
    expect(await posted(a.id)).toEqual([]);
    expect(warnings.map((w) => w.msg)).toContain('coordination post failed');

    s.fake.postFailWith = undefined;
    say('bob', 'something else');
    await settle();
    expect(s.fake.sent).toHaveLength(1);
    const [row] = await posted(a.id);
    expect(row?.signal_key).toBe(signalKey(a.id, 'conflict', ['X1']));
    expect(row?.message_id).toBe(s.fake.sent[0]?.messageId);
  });

  it('assist: at most 3 posts per 5 minutes per room; conflicts skip the 8-message gap', async () => {
    await session('assist');
    await start();
    for (let i = 1; i <= 4; i++) {
      say('alice', `raise conflict topic number ${String(i)}`);
      await settle();
    }
    expect(s.fake.sent.map((m) => m.content)).toEqual(
      [1, 2, 3].map((i) => expect.stringContaining(`topic number ${String(i)}`) as unknown),
    );
    // Non-conflict signals wait for the gap as well as the window.
    say('alice', 'raise dependency_deadlock we wait on each other');
    await settle();
    expect(s.fake.sent).toHaveLength(3);

    clock += 5 * 60_000;
    say('bob', 'anything');
    await settle();
    // The window reopened: the pending conflict goes out alone (the deadlock still waits for 8 messages).
    expect(s.fake.sent).toHaveLength(4);
    expect(s.fake.sent[3]?.content).toContain('topic number 4');
    expect(s.fake.sent[3]?.content).not.toContain('each other');
  });

  it('assist: two sessions of one room produce one post for a shared signal, and both record it', async () => {
    const a = await session('assist');
    const b = await session('assist');
    await start();
    say('alice', 'raise conflict retries are free');
    await settle();
    expect(s.fake.sent).toHaveLength(1);
    const [ra] = await posted(a.id);
    const [rb] = await posted(b.id);
    expect(ra?.message_id).toBe(s.fake.sent[0]?.messageId);
    expect(rb?.message_id).toBe(s.fake.sent[0]?.messageId);
    expect(ra?.signal_key).not.toBe(rb?.signal_key);
  });

  it('leak rule: posts never carry the session name or id, or a task id or title', async () => {
    const name = 'Zanzibar Operation 7731';
    const title = 'Quokka secret title 4410';
    const a = await session('assist', name);
    const [task] = await s.owner<{ id: string }>(
      `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title, state, creator_actor_id)
       VALUES ($1, $2, $3, 'task', $4, $5, 'ready', $6) RETURNING id`,
      [s.workspaceId, a.id, a.boardId, s.roomId, title, a.adminId],
    );
    const taskId = task?.id ?? '';
    await start();
    say('alice', 'raise conflict the schema is final');
    await settle();
    // The objects now carry a task link (session-private) and every later signal must still not show it.
    await s.owner(
      `UPDATE conversation_objects SET linked_item_id = $2, body = jsonb_set(body, '{linked_item_id}', to_jsonb($2::uuid))
        WHERE session_id = $1`,
      [a.id, taskId],
    );
    for (const kind of POSTABLE_KINDS.slice(1)) {
      clock += 5 * 60_000;
      chatter(8);
      say('alice', `raise ${kind} about the release plan`);
      await settle();
    }
    expect(s.fake.sent.length).toBeGreaterThanOrEqual(POSTABLE_KINDS.length);
    const everything = JSON.stringify(s.fake.sent.map((m) => [m.content, m.replyTo]));
    for (const secret of [name, title, a.id, taskId, 'Zanzibar', 'Quokka', a.adminId, a.boardId]) {
      expect(everything).not.toContain(secret);
    }
    for (const m of s.fake.sent) {
      for (const line of m.content.split('\n'))
        expect(line).toMatch(/^\[chorus\] .+ \(refs: \d+(, \d+)*\)$/);
    }
  });
});
