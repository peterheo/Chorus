import { describe, expect, it } from 'vitest';
import { evaluate, type CoordState } from '../../src/index.ts';
import { Script, alice, bob, carol, dave, deepFreeze } from './coordination-script.ts';

const at = (state: CoordState, cursor: number): CoordState => ({ ...state, cursor });
const kinds = (state: CoordState) => evaluate(state).map((signal) => signal.kind);
const only = (state: CoordState, kind: string) =>
  evaluate(state).filter((signal) => signal.kind === kind);

const claim = (subject: string, predicate: string, over: Record<string, unknown> = {}) => ({
  type: 'claim' as const,
  subject,
  predicate,
  polarity: 'pos' as const,
  ...over,
});

describe('CC-2a rules (§5)', () => {
  it('conflict: a detected conflict, with the exact template; none once resolved', () => {
    const s = new Script();
    const k1 = s.say(alice, claim('the staging deploy', 'broken'));
    s.say(bob, claim('staging deploy', 'broken', { polarity: 'neg' }));
    expect(evaluate(s.run().state)).toEqual([
      {
        kind: 'conflict',
        refs: ['X1', 'K1', 'K2'],
        members: [alice, bob],
        reason: 'Two members made opposite claims about the same thing.',
        suggested_next_action:
          'Resolve conflict X1: alice and bob disagree on "the staging deploy". Settle it in the room, or record a decision.',
      },
    ]);
    s.say(alice, { type: 'withdrawal' }, { reply: k1 });
    expect(only(s.run().state, 'conflict')).toEqual([]);
  });

  it('decision_contradicted: same subject and a different value or opposite polarity; not hedged', () => {
    const s = new Script();
    s.say(alice, { type: 'decision', subject: 'the staging port', value: '6543' });
    s.say(bob, claim('staging port', '5432'));
    s.say(carol, claim('the staging port', '6543')); // agrees
    s.say(dave, claim('staging port', '5432', { hedged: true })); // hedged
    s.say(carol, claim('the prod port', '5432')); // other subject
    const signals = only(s.run().state, 'decision_contradicted');
    expect(signals).toEqual([
      {
        kind: 'decision_contradicted',
        refs: ['K1', 'D1'],
        members: [bob, alice],
        reason: 'An active claim disagrees with an active decision.',
        suggested_next_action:
          'Claim K1 by bob contradicts decision D1. Confirm the decision or supersede it.',
      },
    ]);

    const polar = new Script();
    polar.say(alice, { type: 'decision', subject: 'the cache', polarity: 'pos' });
    polar.say(bob, claim('the cache', 'enabled', { polarity: 'neg' }));
    expect(only(polar.run().state, 'decision_contradicted').map((x) => x.refs)).toEqual([
      ['K1', 'D1'],
    ]);
  });

  it('duplicate_commitments: different owners, Jaccard ≥ 0.5, ≥ 3 content tokens each', () => {
    const s = new Script();
    s.say(bob, { type: 'commitment', text: 'I will update the rotation runbook today' });
    s.say(dave, { type: 'commitment', text: 'I will update the runbook for the rotation' });
    s.say(bob, { type: 'commitment', text: 'I will update the runbook for rotation' }); // same owner as C1
    s.say(carol, { type: 'commitment', text: 'I will update it' }); // too few tokens
    expect(only(s.run().state, 'duplicate_commitments')).toEqual([
      {
        kind: 'duplicate_commitments',
        refs: ['C1', 'C2'],
        members: [bob, dave],
        reason: 'Two members committed to similar work.',
        suggested_next_action:
          'bob and dave both committed to similar work (C1, C2). Create one task and link both, or split the work.',
      },
      expect.objectContaining({ refs: ['C2', 'C3'] }),
    ]);
    s.say(dave, { type: 'completion' });
    expect(only(s.run().state, 'duplicate_commitments')).toEqual([]);
  });

  it('dependency_resolved: resolved within the last 12 messages of the cursor', () => {
    const s = new Script();
    s.say(bob, { type: 'commitment' });
    s.say(alice, { type: 'dependency', blocker: { ref: 'C1' } });
    expect(only(s.run().state, 'dependency_resolved')).toEqual([]); // still waiting
    s.say(bob, { type: 'completion' });
    const state = s.run().state;
    expect(only(state, 'dependency_resolved')).toEqual([
      {
        kind: 'dependency_resolved',
        refs: ['P1', 'C1'],
        members: [alice],
        reason: 'What a member was waiting on is settled.',
        suggested_next_action: 'alice: P1 is unblocked, because C1 is completed.',
      },
    ]);
    expect(only(at(state, 14), 'dependency_resolved')).toHaveLength(1);
    expect(only(at(state, 15), 'dependency_resolved')).toEqual([]);
  });

  it('dependency_deadlock: a waits-on cycle, rotated to the smallest member id; a chain is not one', () => {
    const s = new Script();
    s.say(bob, { type: 'commitment' });
    s.say(carol, { type: 'commitment' });
    s.say(alice, { type: 'commitment' });
    s.say(carol, { type: 'dependency', blocker: { member: alice } }); // carol → alice
    s.say(alice, { type: 'dependency', blocker: { member: bob } }); // alice → bob
    expect(only(s.run().state, 'dependency_deadlock')).toEqual([]);
    s.say(bob, { type: 'dependency', blocker: { member: carol } }); // bob → carol
    expect(only(s.run().state, 'dependency_deadlock')).toEqual([
      {
        kind: 'dependency_deadlock',
        refs: ['P2', 'P3', 'P1'],
        members: [alice, bob, carol],
        reason: 'Members are waiting on each other in a cycle.',
        suggested_next_action:
          'Deadlock: alice waits on bob waits on carol waits on alice. One of you must go first.',
      },
    ]);
    s.say(bob, { type: 'completion', refs: ['C1'] }); // P2 resolves: the cycle is broken
    expect(only(s.run().state, 'dependency_deadlock')).toEqual([]);
  });

  it('unanswered_question: open with cursor − created_seq ≥ 12', () => {
    const s = new Script();
    s.say(alice, { type: 'question' });
    s.say(alice, { type: 'question', targets: [bob] });
    s.say(bob, { type: 'acknowledgement', refs: ['Q2'] }); // acknowledged: not "open"
    const state = s.run().state;
    expect(only(at(state, 12), 'unanswered_question')).toEqual([]);
    expect(only(at(state, 20), 'unanswered_question')).toEqual([
      {
        kind: 'unanswered_question',
        refs: ['Q1'],
        members: [alice],
        reason: 'A question has had no answer for a while.',
        suggested_next_action:
          'Unanswered question Q1 from alice. Answer it, or create a task and link it.',
      },
    ]);
    expect(only(at(state, 13), 'unanswered_question')).toHaveLength(1);
  });

  it('missing_acknowledgement: the target has ≥ 3 messages after a pending handoff', () => {
    const s = new Script();
    s.say(alice, { type: 'handoff', targets: [bob] });
    s.say(bob, { type: 'question' });
    s.say(carol, []);
    s.say(bob, []);
    expect(only(s.run().state, 'missing_acknowledgement')).toEqual([]);
    s.say(bob, []);
    expect(only(s.run().state, 'missing_acknowledgement')).toEqual([
      {
        kind: 'missing_acknowledgement',
        refs: ['H1'],
        members: [bob, alice],
        reason: 'The target of a handoff kept talking without acknowledging it.',
        suggested_next_action: "bob hasn't acknowledged handoff H1 from alice.",
      },
    ]);
  });

  it('stale_commitment: open or in progress with cursor − touched_seq ≥ 30', () => {
    const s = new Script();
    s.say(bob, { type: 'commitment' });
    s.say(bob, { type: 'status_update' });
    const state = s.run().state;
    expect(only(at(state, 31), 'stale_commitment')).toEqual([]);
    expect(only(at(state, 32), 'stale_commitment')).toEqual([
      {
        kind: 'stale_commitment',
        refs: ['C1'],
        members: [bob],
        reason: 'An open commitment has had no update for a while.',
        suggested_next_action:
          "bob's commitment C1 has had no update for 30 messages. Update, complete or withdraw it.",
      },
    ]);
  });

  it('ready_to_close: at least one object and nothing unsettled', () => {
    const s = new Script();
    expect(kinds(s.run().state)).toEqual([]);
    s.say(alice, { type: 'decision', subject: 'the cache' });
    s.say(bob, { type: 'commitment' });
    expect(kinds(s.run().state)).toEqual([]);
    s.say(bob, { type: 'completion' });
    expect(evaluate(s.run().state)).toEqual([
      {
        kind: 'ready_to_close',
        refs: [],
        members: [],
        reason: 'Nothing tracked in this conversation is open.',
        suggested_next_action:
          'Everything tracked in this conversation is settled. Nothing is open.',
      },
    ]);
  });

  it('orders by kind priority, then the oldest created_seq; pure over frozen state', () => {
    const s = new Script();
    s.say(alice, { type: 'question' }); // unanswered later
    s.say(bob, { type: 'commitment', text: 'I will rewrite the billing export job' });
    s.say(carol, { type: 'commitment', text: 'I will rewrite billing export job' });
    s.say(dave, claim('the export job', 'flaky'));
    s.say(alice, claim('export job', 'flaky', { polarity: 'neg' }));
    s.say(carol, { type: 'commitment', text: 'I will rewrite the billing export job now' });
    const state = deepFreeze(at(s.run().state, 40));
    expect(evaluate(state).map((x) => `${x.kind}:${x.refs.join('+')}`)).toEqual([
      'conflict:X1+K1+K2',
      'duplicate_commitments:C1+C2',
      'duplicate_commitments:C1+C3',
      'unanswered_question:Q1',
      'stale_commitment:C1',
      'stale_commitment:C2',
      'stale_commitment:C3',
    ]);
  });
});
