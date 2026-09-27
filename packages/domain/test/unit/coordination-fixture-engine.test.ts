/**
 * CC-2a end to end: the REAL engine (`applyMessages` = `createEngine(extractEvents)`) and `evaluate` over S1's
 * labelled fixture (`coordination-fixture.json`, m1–m44) followed by `coordination-fixture-engine.json`'s
 * `continuation` (e45–e83), which covers every §4 transition and every §5 signal through the real extractor,
 * plus its `closing` conversation (the only way to reach `ready_to_close`: m3's take-over handoff has no target
 * and stays pending forever). Objects, transitions, signals and the cursor are asserted exactly.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  applyMessages,
  evaluate,
  type ApplyResult,
  type CoordState,
  type SourceMessage,
  type Transition,
} from '../../src/index.ts';
import { extractEvents } from '../../src/coordination/extract.ts';
import { deepFreeze, seeded } from './coordination-script.ts';

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const extra = load('coordination-fixture-engine.json') as {
  continuation: SourceMessage[];
  closing: SourceMessage[];
};
const fixture: readonly SourceMessage[] = [
  ...(load('coordination-fixture.json') as SourceMessage[]),
  ...extra.continuation,
];
const ctx = { excludeMemberIds: [] };
const run = (messages: readonly SourceMessage[], state: CoordState = EMPTY_STATE): ApplyResult =>
  applyMessages(state, messages, ctx);
const upTo = (seq: number) => run(fixture.filter((m) => m.sequence <= seq)).state;

/** `ref kind status owner targets related`, `-` for none. */
const objectsOf = (state: CoordState) =>
  state.objects.map((o) =>
    [
      o.ref,
      o.kind,
      o.status,
      o.owner?.name ?? '-',
      o.targets.map((t) => t.name).join('+') || '-',
      o.related.join('+') || '-',
    ].join(' '),
  );
const transitionsOf = (result: ApplyResult) =>
  result.transitions.map((t) => `${t.ref}:${String(t.from)}>${t.to}`);
const signalsOf = (state: CoordState) =>
  evaluate(state).map((s) => `${s.kind}:${s.refs.join('+')}`);

describe('CC-2a fixture through the real engine', () => {
  const result = run(fixture);

  it('covers 83 messages from alice, bob, carol and dave; the cursor ends at the last one', () => {
    expect(fixture).toHaveLength(83);
    expect(result.state.cursor).toBe(83);
  });

  it('ends with exactly these objects', () => {
    expect(objectsOf(result.state)).toEqual([
      'Q1 question answered - - -',
      'Q2 question open - - -', // m2 "Dave, could you …": dave is on no object yet (roster limitation)
      'H1 handoff pending - - -', // m3 "I can take over C1": no target, pending forever
      'C1 commitment completed bob - -',
      'C2 commitment withdrawn carol - -',
      'C3 commitment completed dave - -',
      'D1 decision superseded - - D4',
      'D2 decision active - - -',
      'K1 claim active - - -',
      'K2 claim active - - -',
      'X1 conflict resolved - carol K1+K2',
      'K3 claim active - - -',
      'P1 dependency resolved - bob C1',
      'Q3 question open - - -',
      'H2 handoff accepted carol carol C4',
      'C4 commitment withdrawn carol - H2',
      'C5 commitment open bob - -',
      'Q4 question open - - -',
      'C6 commitment open bob - -',
      'K4 claim active - - -',
      'K5 claim active - - -',
      'Q5 question open - - -',
      'D3 decision active - - -',
      'H3 handoff pending - carol -',
      'K6 claim active - - -',
      'H4 handoff completed bob bob C7',
      'C7 commitment completed bob - H4',
      'H5 handoff accepted dave dave C8',
      'C8 commitment withdrawn dave - H5',
      'H6 handoff declined - carol -',
      'H7 handoff completed bob bob C8+C9',
      'C9 commitment completed bob - H7',
      'Q6 question answered - dave -',
      'Q7 question withdrawn - - -',
      'C10 commitment completed carol - Q7',
      'Q8 question open - - Q6',
      'D4 decision active - - D1',
      'K7 claim active - - -',
      'D5 decision active - - -',
      'K8 claim active - - -',
      'K9 claim retracted - - -',
      'X2 conflict resolved - alice K8+K9',
      'K10 claim active - - -',
      'K11 claim superseded - - K12',
      'X3 conflict resolved - bob K10+K11',
      'K12 claim active - - K11',
      'K13 claim active - - -',
      'K14 claim active - - -',
      'K15 claim active - - -',
      'H8 handoff pending - dave -',
      'C11 commitment open carol - -',
      'P2 dependency resolved - bob C9',
      'P3 dependency waiting - carol C11',
      'C12 commitment open alice - -',
      'C13 commitment open dave - -',
    ]);
  });

  it('emits exactly these transitions', () => {
    // prettier-ignore
    expect(transitionsOf(result)).toEqual([
      'Q1:null>open', 'Q2:null>open', 'H1:null>pending', 'C1:null>open', 'C2:null>open', 'C3:null>open',
      'Q1:open>answered', 'C1:open>in_progress', 'C1:in_progress>completed', 'C2:open>withdrawn',
      'D1:null>active', 'D2:null>active', 'K1:null>active', 'K2:null>active', 'X1:null>detected',
      'K3:null>active', 'P1:null>waiting', 'P1:waiting>resolved', 'Q3:null>open', 'H2:null>pending',
      'H2:pending>accepted', 'C4:null>open', 'C5:null>open', 'Q4:null>open', 'C6:null>open', 'K4:null>active',
      'C4:open>withdrawn', 'C3:open>in_progress', 'K5:null>active', 'Q5:null>open', 'D3:null>active',
      'H3:null>pending', 'K6:null>active',
      // e45–e83
      'H4:null>pending', 'H4:pending>accepted', 'C7:null>open', 'H5:null>pending', 'H5:pending>accepted',
      'C8:null>open', 'H6:null>pending', 'H6:pending>declined', 'C7:open>completed', 'H4:accepted>completed',
      'H7:null>pending', 'C8:open>withdrawn', 'H7:pending>accepted', 'C9:null>open', 'Q6:null>open',
      'Q6:open>acknowledged', 'Q6:acknowledged>answered', 'Q7:null>open', 'C10:null>open',
      'Q7:open>acknowledged', 'Q7:acknowledged>withdrawn', 'Q8:null>open', 'C10:open>completed',
      'C3:in_progress>completed', 'D4:null>active', 'D1:active>superseded', 'K7:null>active', 'D5:null>active',
      'X1:detected>resolved', 'K8:null>active', 'K9:null>active', 'X2:null>detected', 'K9:active>retracted',
      'X2:detected>resolved', 'K10:null>active', 'K11:null>active', 'X3:null>detected', 'K12:null>active',
      'K11:active>superseded', 'X3:detected>resolved', 'K13:null>active', 'K14:null>active', 'K15:null>active',
      'H8:null>pending', 'C11:null>open', 'P2:null>waiting', 'P3:null>waiting', 'C9:open>completed',
      'H7:accepted>completed', 'P2:waiting>resolved', 'C12:null>open', 'C13:null>open',
    ]);
    expect(result.transitions.find((t) => t.ref === 'C8' && t.to === 'withdrawn')?.reason).toBe(
      'transferred',
    );
  });

  it('raises exactly these signals along the way', () => {
    expect(signalsOf(upTo(44))).toEqual([
      'conflict:X1+K1+K2',
      'unanswered_question:Q2',
      'unanswered_question:Q3',
      'unanswered_question:Q4',
    ]);
    const deadlocked = upTo(79);
    expect(signalsOf(deadlocked)).toEqual([
      'decision_contradicted:K2+D5',
      'decision_contradicted:K7+D4',
      'dependency_deadlock:P3+P2',
      'unanswered_question:Q2',
      'unanswered_question:Q3',
      'unanswered_question:Q4',
      'unanswered_question:Q5',
      'unanswered_question:Q8',
      'missing_acknowledgement:H3',
      'stale_commitment:C5',
      'stale_commitment:C6',
    ]);
    expect(evaluate(deadlocked)[2]?.suggested_next_action).toBe(
      'Deadlock: bob waits on carol waits on bob. One of you must go first.',
    );
    expect(signalsOf(result.state)).toEqual([
      'decision_contradicted:K2+D5',
      'decision_contradicted:K7+D4',
      'duplicate_commitments:C12+C13',
      'dependency_resolved:P2+C9',
      'unanswered_question:Q2',
      'unanswered_question:Q3',
      'unanswered_question:Q4',
      'unanswered_question:Q5',
      'unanswered_question:Q8',
      'missing_acknowledgement:H3',
      'missing_acknowledgement:H8',
      'stale_commitment:C5',
      'stale_commitment:C6',
    ]);
  });

  it('§6 negatives end to end', () => {
    const conflicts = result.state.objects.filter((o) => o.kind === 'conflict');
    const inConflict = new Set(conflicts.flatMap((o) => o.related));
    // e72 "…warm if the job ran" (K13) vs e73 "…is not warm" (K14): conditions differ; e74 "Maybe…" (K15) is hedged.
    for (const ref of ['K13', 'K14', 'K15']) expect(inConflict.has(ref), ref).toBe(false);
    expect(result.state.objects.find((o) => o.ref === 'K13')?.conditions).toEqual([
      'if the job ran.',
    ]);
    expect(result.state.objects.find((o) => o.ref === 'K15')?.hedged).toBe(true);
    // e76 "ok" replying to an unrelated message (e73) does not accept H8.
    expect(upTo(76).objects.find((o) => o.ref === 'H8')?.status).toBe('pending');
    // m23 "I can't look at it this week." creates nothing.
    expect(upTo(23).objects).toEqual(upTo(22).objects);
  });

  it('the closing conversation settles everything: ready_to_close', () => {
    const closing = run(extra.closing);
    expect(objectsOf(closing.state)).toEqual([
      'C1 commitment completed bob - -',
      'H1 handoff completed bob bob C2',
      'C2 commitment completed bob - H1',
      'Q1 question answered - - -',
    ]);
    expect(signalsOf(closing.state)).toEqual(['ready_to_close:']);
    expect(closing.state.cursor).toBe(7);
  });

  it('a replay of the same messages makes no transitions and changes nothing', () => {
    const replay = run(fixture, result.state);
    expect(replay.transitions).toEqual([]);
    expect(replay.state).toEqual(result.state);
  });

  it('is pure: deep-frozen state and messages give the same result', () => {
    const middle = upTo(50);
    const expected = run(fixture, structuredClone(middle));
    const frozen = run(
      deepFreeze(structuredClone([...fixture])),
      deepFreeze(structuredClone(middle)),
    );
    expect(frozen).toEqual(expected);
    expect(frozen.state).toEqual(result.state);
  });

  it('one message at a time, and 20 seeded random splits, equal one call', () => {
    const random = seeded(83);
    for (let round = 0; round <= 20; round += 1) {
      let state = EMPTY_STATE;
      const transitions: Transition[] = [];
      for (let at = 0; at < fixture.length;) {
        const size = round === 0 ? 1 : 1 + Math.floor(random() * 8);
        const step = run(fixture.slice(at, at + size), state);
        state = step.state;
        transitions.push(...step.transitions);
        at += size;
      }
      expect(state).toEqual(result.state);
      expect(transitions).toEqual(result.transitions);
    }
  });
});

describe('rules-v2 fixes found end to end', () => {
  const roster = [
    { member_id: 'i_bob', name: 'bob' },
    { member_id: 'i_dave', name: 'dave' },
  ];
  const say = (content: string): SourceMessage => ({
    message_id: 'x1',
    sequence: 1,
    sender_member_id: 'i_dave',
    sender_principal_id: 'p_i_dave',
    sender_name: 'dave',
    content,
    reply_to_message_id: null,
  });
  const only = (content: string) => extractEvents(say(content), roster)[0];

  it('a take-over handoff names its target', () => {
    expect(only('Bob, please take over my C8.')).toMatchObject({
      type: 'handoff',
      take_over: 'C8',
      targets: [{ member_id: 'i_bob', name: 'bob' }],
    });
  });

  it('a claim condition is split off the whole sentence, leading or trailing', () => {
    expect(only('The cron job runs fine if the network is stable.')).toBeUndefined();
    expect(only('If the cache is cold, the deploy is slow.')).toMatchObject({
      subject: 'the deploy',
      predicate: 'slow.',
      conditions: ['If the cache is cold'],
    });
    expect(only('The deploy is slow when the cache is cold.')).toMatchObject({
      subject: 'The deploy',
      predicate: 'slow',
      conditions: ['when the cache is cold.'],
    });
  });

  it('a leading hedge is not part of the subject', () => {
    expect(only('I think the cache layer works well.')).toMatchObject({
      subject: 'the cache layer',
      hedged: true,
    });
  });
});
