import { describe, expect, it } from 'vitest';
import { EMPTY_STATE, type CoordState } from '../../src/index.ts';
import { applyEvents, rosterOf } from '../../src/coordination/engine.ts';
import {
  Script,
  alice,
  bob,
  carol,
  chorus,
  dave,
  deepFreeze,
  find,
  seeded,
  statuses,
} from './coordination-script.ts';

const danny = { member_id: 'm_danny', name: 'danny' };
const dana = { member_id: 'm_dana', name: 'dana' };

const transitionsOf = (s: Script) =>
  s.run().transitions.map((t) => `${t.ref}:${String(t.from)}>${t.to}`);

describe('CC-2a engine: questions', () => {
  it('open → acknowledged by a targeted member → answered by an answer event', () => {
    const s = new Script();
    const q = s.say(alice, { type: 'question', targets: [bob] });
    s.say(carol, { type: 'acknowledgement' }, { reply: q }); // not targeted: nothing
    s.say(bob, { type: 'acknowledgement' }, { reply: q });
    s.say(bob, { type: 'answer', answers: 'Q1' });
    const { state, transitions } = s.run();
    expect(transitions).toEqual([
      {
        ref: 'Q1',
        from: null,
        to: 'open',
        cause: 'message',
        message_id: 'msg_001',
        reason: 'asked',
      },
      {
        ref: 'Q1',
        from: 'open',
        to: 'acknowledged',
        cause: 'message',
        message_id: 'msg_003',
        reason: 'acknowledged by target',
      },
      {
        ref: 'Q1',
        from: 'acknowledged',
        to: 'answered',
        cause: 'message',
        message_id: 'msg_004',
        reason: 'answered',
      },
    ]);
    expect(find(state, 'Q1')).toMatchObject({
      targets: [bob],
      sources: [
        { message_id: 'msg_001', sequence: 1 },
        { message_id: 'msg_003', sequence: 3 },
        { message_id: 'msg_004', sequence: 4 },
      ],
      created_seq: 1,
      touched_seq: 4,
    });
  });

  it("an answer event from the question's author does not answer it", () => {
    const s = new Script();
    s.say(alice, { type: 'question' });
    s.say(alice, { type: 'answer', answers: 'Q1' });
    expect(statuses(s.run().state)).toEqual({ Q1: 'open' });
  });

  it('a reply from a non-author answers it whatever the event type, but not a counter-question', () => {
    const s = new Script();
    const q = s.say(alice, { type: 'question' });
    s.say(alice, [], { reply: q }); // the author's own reply
    s.say(bob, { type: 'question' }, { reply: q }); // a counter-question keeps its meaning
    expect(statuses(s.run().state)).toEqual({ Q1: 'open', Q2: 'open' });
    s.say(
      carol,
      { type: 'claim', subject: 'port', predicate: '5432', polarity: 'pos' },
      { reply: q },
    );
    const { state, transitions } = s.run();
    expect(statuses(state)).toEqual({ Q1: 'answered', Q2: 'open', K1: 'active' });
    expect(transitions.find((t) => t.to === 'answered')).toMatchObject({ reason: 'reply' });
  });

  it('a reply that extracts nothing still answers', () => {
    const s = new Script();
    const q = s.say(alice, { type: 'question' });
    s.say(bob, [], { reply: q });
    expect(statuses(s.run().state)).toEqual({ Q1: 'answered' });
  });

  it('a commitment that replies to or references a question acknowledges it', () => {
    const s = new Script();
    const q = s.say(alice, { type: 'question' });
    s.say(alice, { type: 'question' });
    s.say(bob, { type: 'commitment' }, { reply: q });
    s.say(carol, { type: 'commitment', refs: ['Q2'] });
    const { state } = s.run();
    expect(statuses(state)).toEqual({
      Q1: 'acknowledged',
      Q2: 'acknowledged',
      C1: 'open',
      C2: 'open',
    });
    expect(find(state, 'C1').related).toEqual(['Q1']);
  });

  it("withdrawn only by the author's withdrawal that names it", () => {
    const s = new Script();
    const q = s.say(alice, { type: 'question' });
    s.say(bob, { type: 'withdrawal' }, { reply: q });
    s.say(alice, { type: 'withdrawal' }); // names nothing: not a question withdrawal
    expect(statuses(s.run().state)).toEqual({ Q1: 'open' });
    s.say(alice, { type: 'withdrawal' }, { reply: q });
    expect(statuses(s.run().state)).toEqual({ Q1: 'withdrawn' });
  });

  it('a repeated question (Jaccard ≥ 0.8 with an answered one) is related to it', () => {
    const s = new Script();
    s.say(alice, { type: 'question', text: 'Which port does the staging database use?' });
    s.say(bob, { type: 'answer', answers: 'Q1' });
    s.say(carol, { type: 'question', text: 'which port does staging database use' });
    s.say(carol, { type: 'question', text: 'Which port does the production cache use?' });
    const { state, transitions } = s.run();
    expect(find(state, 'Q2').related).toEqual(['Q1']);
    expect(find(state, 'Q3').related).toEqual([]);
    expect(transitions.find((t) => t.ref === 'Q2')?.reason).toBe('repeats Q1');
  });
});

describe('CC-2a engine: commitments', () => {
  it('open → in_progress (owner status update) → completed (owner completion by ref)', () => {
    const s = new Script();
    s.say(bob, { type: 'commitment', optional: true });
    s.say(bob, { type: 'commitment' });
    s.say(carol, { type: 'status_update', refs: ['C1'] }); // not the owner
    s.say(bob, { type: 'status_update', refs: ['C1'] });
    s.say(bob, { type: 'status_update', refs: ['C1'] }); // a touch, no transition
    s.say(bob, { type: 'completion', refs: ['C1'] });
    const { state, transitions } = s.run();
    expect(statuses(state)).toEqual({ C1: 'completed', C2: 'open' });
    expect(transitions.filter((t) => t.ref === 'C1').map((t) => t.to)).toEqual([
      'open',
      'in_progress',
      'completed',
    ]);
    expect(find(state, 'C1')).toMatchObject({ owner: bob, optional: true, touched_seq: 6 });
    expect(find(state, 'C1').sources.map((x) => x.sequence)).toEqual([1, 4, 5, 6]);
    expect(find(state, 'C2')).not.toHaveProperty('optional');
  });

  it("an unnamed completion closes the owner's ONLY open commitment, never one of several", () => {
    const one = new Script();
    one.say(bob, { type: 'commitment' });
    one.say(bob, { type: 'status_update' });
    one.say(bob, { type: 'completion' });
    expect(statuses(one.run().state)).toEqual({ C1: 'completed' });

    const two = new Script();
    two.say(bob, { type: 'commitment' });
    two.say(bob, { type: 'commitment' });
    two.say(bob, { type: 'completion' });
    two.say(alice, { type: 'completion' });
    expect(statuses(two.run().state)).toEqual({ C1: 'open', C2: 'open' });
  });

  it('a completion replying to the commitment message closes that one', () => {
    const s = new Script();
    const c = s.say(bob, { type: 'commitment' });
    s.say(bob, { type: 'commitment' });
    s.say(bob, { type: 'completion' }, { reply: c });
    expect(statuses(s.run().state)).toEqual({ C1: 'completed', C2: 'open' });
  });

  it("withdrawn by the owner's withdrawal (unnamed: the latest created)", () => {
    const s = new Script();
    s.say(bob, { type: 'commitment' });
    s.say(bob, { type: 'commitment' });
    s.say(alice, { type: 'withdrawal' });
    s.say(bob, { type: 'withdrawal' });
    s.say(bob, { type: 'withdrawal', refs: ['C1'] });
    expect(statuses(s.run().state)).toEqual({ C1: 'withdrawn', C2: 'withdrawn' });
    expect(transitionsOf(s)).toEqual([
      'C1:null>open',
      'C2:null>open',
      'C2:open>withdrawn',
      'C1:open>withdrawn',
    ]);
  });
});

describe('CC-2a engine: handoffs', () => {
  it('accepted by a target acknowledgement replying to it: a commitment for the target, related [H]', () => {
    const s = new Script();
    const h = s.say(alice, {
      type: 'handoff',
      targets: [bob],
      text: 'bob, can you rotate the keys?',
    });
    s.say(bob, { type: 'status_update' });
    s.say(bob, { type: 'acknowledgement' }, { reply: h });
    const { state, transitions } = s.run();
    expect(statuses(state)).toEqual({ H1: 'accepted', C1: 'open' });
    expect(find(state, 'C1')).toMatchObject({
      text: 'bob, can you rotate the keys?',
      author: bob,
      owner: bob,
      related: ['H1'],
      created_seq: 3,
    });
    expect(find(state, 'H1')).toMatchObject({ owner: bob, related: ['C1'] });
    expect(transitions.slice(1).map((t) => [t.ref, t.to, t.reason])).toEqual([
      ['H1', 'accepted', 'accepted by target'],
      ['C1', 'open', 'accepted H1'],
    ]);
  });

  it("accepted when the target's NEXT message is an acknowledgement that replies to nothing", () => {
    const s = new Script();
    s.say(alice, { type: 'handoff', targets: [bob] });
    s.say(carol, { type: 'acknowledgement' }); // not the target
    s.say(bob, { type: 'acknowledgement' });
    expect(statuses(s.run().state)).toEqual({ H1: 'accepted', C1: 'open' });
  });

  it('NOT accepted by an ack replying to an unrelated message, or by a later ack', () => {
    const s = new Script();
    const other = s.say(carol, []);
    s.say(alice, { type: 'handoff', targets: [bob] });
    s.say(bob, { type: 'acknowledgement' }, { reply: other });
    s.say(bob, { type: 'acknowledgement' }); // no longer his next message
    const { state } = s.run();
    expect(statuses(state)).toEqual({ H1: 'pending' });
    expect(find(state, 'H1').sources.map((x) => x.sequence)).toEqual([2, 3, 4]);
  });

  it('a target commitment replying to the handoff accepts it without a second commitment', () => {
    const s = new Script();
    const h = s.say(alice, { type: 'handoff', targets: [bob] });
    s.say(bob, { type: 'commitment' }, { reply: h });
    expect(statuses(s.run().state)).toEqual({ H1: 'accepted', C1: 'open' });
  });

  it("a target commitment that is their next message and names nothing accepts it ('I've got this')", () => {
    const s = new Script();
    s.say(alice, { type: 'handoff', targets: [bob] });
    s.say(bob, { type: 'commitment' });
    s.say(alice, { type: 'handoff', targets: [carol] });
    s.say(carol, { type: 'commitment', refs: ['C1'] }); // names something else: a plain commitment
    s.say(alice, { type: 'handoff', targets: [dave] });
    s.say(dave, []);
    s.say(dave, { type: 'commitment' }); // not his next message
    expect(statuses(s.run().state)).toEqual({
      H1: 'accepted',
      C1: 'open',
      H2: 'pending',
      C2: 'open',
      H3: 'pending',
      C3: 'open',
    });
  });

  it('declined by a target decline; completed when its commitment completes', () => {
    const s = new Script();
    const h1 = s.say(alice, { type: 'handoff', targets: [bob] });
    s.say(bob, { type: 'decline' }, { reply: h1 });
    s.say(alice, { type: 'handoff', targets: [carol] });
    s.say(carol, { type: 'acknowledgement' });
    s.say(carol, { type: 'completion', refs: ['H2'] });
    const { state, transitions } = s.run();
    expect(statuses(state)).toEqual({ H1: 'declined', H2: 'completed', C1: 'completed' });
    expect(transitions.at(-1)).toMatchObject({
      ref: 'H2',
      to: 'completed',
      reason: 'C1 completed',
    });
  });

  it("`take over Cn` withdraws the sender's Cn as transferred", () => {
    const s = new Script();
    s.say(alice, { type: 'commitment' });
    s.say(bob, { type: 'commitment' });
    s.say(alice, { type: 'handoff', targets: [carol], take_over: 'C1' });
    s.say(alice, { type: 'handoff', targets: [carol], take_over: 'C2' }); // not hers
    const { state, transitions } = s.run();
    expect(statuses(state)).toEqual({ C1: 'withdrawn', C2: 'open', H1: 'pending', H2: 'pending' });
    expect(find(state, 'H1').related).toEqual(['C1']);
    expect(transitions.find((t) => t.ref === 'C1' && t.to === 'withdrawn')?.reason).toBe(
      'transferred',
    );
  });
});

describe('CC-2a engine: decisions and claims', () => {
  it('a decision on the same subject supersedes the older one, related both ways', () => {
    const s = new Script();
    s.say(alice, { type: 'decision', subject: 'the staging database', value: 'postgres 18' });
    s.say(bob, { type: 'decision', subject: 'the cache' });
    s.say(carol, { type: 'decision', subject: 'staging database', value: 'postgres 17' });
    const { state } = s.run();
    expect(statuses(state)).toEqual({ D1: 'superseded', D2: 'active', D3: 'active' });
    expect(find(state, 'D1').related).toEqual(['D3']);
    expect(find(state, 'D3')).toMatchObject({ related: ['D1'], value: 'postgres 17' });
  });

  it("claims: retracted by the author's withdrawal, superseded by the author's later claim", () => {
    const s = new Script();
    const k = s.say(alice, { type: 'claim', subject: 'the build', predicate: 'green' });
    s.say(bob, { type: 'withdrawal' }, { reply: k }); // not the author
    s.say(alice, { type: 'claim', subject: 'the deploy', predicate: 'slow' });
    s.say(alice, { type: 'claim', subject: 'deploy', predicate: 'fast' });
    s.say(alice, { type: 'withdrawal' }, { reply: k });
    const { state } = s.run();
    expect(statuses(state)).toEqual({ K1: 'retracted', K2: 'superseded', K3: 'active' });
    expect(find(state, 'K2').related).toEqual(['K3']);
  });
});

describe('CC-2a engine: conflicts', () => {
  const claim = (over: Record<string, unknown> = {}) => ({
    type: 'claim' as const,
    subject: 'the staging deploy',
    predicate: 'broken',
    polarity: 'pos' as const,
    ...over,
  });

  it('two active opposite unhedged claims by different authors conflict', () => {
    const s = new Script();
    s.say(alice, claim());
    s.say(bob, claim({ polarity: 'neg', subject: 'staging deploy' }));
    const { state, transitions } = s.run();
    expect(statuses(state)).toEqual({ K1: 'active', K2: 'active', X1: 'detected' });
    expect(find(state, 'X1')).toMatchObject({
      author: bob,
      targets: [alice],
      related: ['K1', 'K2'],
      subject: 'the staging deploy',
    });
    expect(transitions.at(-1)?.reason).toBe('K1 vs K2');
  });

  it.each([
    ['hedged', claim({ polarity: 'neg', hedged: true })],
    ['same polarity', claim()],
    ['different predicate', claim({ polarity: 'neg', predicate: 'slow today' })],
    ['different subject', claim({ polarity: 'neg', subject: 'the prod deploy' })],
    [
      'a condition on one side only',
      claim({ polarity: 'neg', conditions: ['if the cache is warm'] }),
    ],
  ])('no conflict: %s', (_name, second) => {
    const s = new Script();
    s.say(alice, claim());
    s.say(bob, second);
    expect(s.run().state.objects.some((o) => o.kind === 'conflict')).toBe(false);
  });

  it('no conflict with oneself; equal conditions (after normalization) do conflict', () => {
    const self = new Script();
    self.say(alice, claim({ subject: 'the api' }));
    self.say(alice, claim({ subject: 'the web', polarity: 'neg' }));
    expect(self.run().state.objects.some((o) => o.kind === 'conflict')).toBe(false);

    const s = new Script();
    s.say(alice, claim({ conditions: ['When the cache is warm'] }));
    s.say(bob, claim({ polarity: 'neg', conditions: ['when cache warm'] }));
    expect(statuses(s.run().state)).toMatchObject({ X1: 'detected' });
  });

  it('resolved when a claim is retracted, or a decision on the subject is made', () => {
    const s = new Script();
    const k1 = s.say(alice, claim());
    s.say(bob, claim({ polarity: 'neg' }));
    s.say(alice, { type: 'withdrawal' }, { reply: k1 });
    s.say(carol, claim({ polarity: 'neg' }));
    s.say(dave, claim());
    s.say(bob, { type: 'decision', subject: 'staging deploy' });
    const { state, transitions } = s.run();
    expect(statuses(state)).toMatchObject({
      K1: 'retracted',
      X1: 'resolved',
      X2: 'resolved',
      X3: 'resolved',
    });
    expect(transitions.find((t) => t.ref === 'X1' && t.to === 'resolved')?.reason).toBe(
      'K1 retracted',
    );
    expect(transitions.find((t) => t.ref === 'X3' && t.to === 'resolved')?.reason).toBe(
      'decided by D1',
    );
  });

  it("resolved when a claim is superseded by its author's later claim", () => {
    const s = new Script();
    s.say(alice, claim());
    s.say(bob, claim({ polarity: 'neg' }));
    s.say(bob, claim({ predicate: 'fixed now' }));
    expect(statuses(s.run().state)).toMatchObject({ K2: 'superseded', X1: 'resolved' });
  });
});

describe('CC-2a engine: dependencies', () => {
  it('blocker by ref; resolved when the blocker completes', () => {
    const s = new Script();
    s.say(bob, { type: 'commitment' });
    s.say(alice, { type: 'dependency', blocker: { ref: 'C1' } });
    s.say(bob, { type: 'completion' });
    const { state, transitions } = s.run();
    expect(statuses(state)).toEqual({ C1: 'completed', P1: 'resolved' });
    expect(find(state, 'P1')).toMatchObject({ author: alice, targets: [bob], related: ['C1'] });
    expect(transitions.at(-1)).toMatchObject({ ref: 'P1', to: 'resolved', reason: 'C1 completed' });
  });

  it("blocker by member: that member's latest open commitment; none → no dependency", () => {
    const s = new Script();
    s.say(bob, { type: 'commitment' });
    s.say(bob, { type: 'commitment' });
    s.say(bob, { type: 'completion', refs: ['C2'] });
    s.say(alice, { type: 'dependency', blocker: { member: bob } });
    s.say(alice, { type: 'dependency', blocker: { member: carol } });
    s.say(alice, { type: 'dependency', blocker: { text: 'the vendor' } });
    s.say(alice, { type: 'dependency', blocker: { ref: 'C9' } });
    const { state } = s.run();
    expect(statuses(state)).toEqual({ C1: 'open', C2: 'completed', P1: 'waiting' });
    expect(find(state, 'P1').related).toEqual(['C1']);
  });

  it('a blocker that is already terminal resolves the dependency on creation', () => {
    const s = new Script();
    s.say(bob, { type: 'commitment' });
    s.say(bob, { type: 'completion' });
    s.say(alice, { type: 'dependency', blocker: { ref: 'C1' } });
    expect(transitionsOf(s).slice(2)).toEqual(['P1:null>waiting', 'P1:waiting>resolved']);
  });

  it('cascades: a dependency on a dependency resolves with it', () => {
    const s = new Script();
    s.say(bob, { type: 'commitment' });
    s.say(alice, { type: 'dependency', blocker: { ref: 'C1' } });
    s.say(carol, { type: 'dependency', blocker: { ref: 'P1' } });
    s.say(bob, { type: 'completion' });
    expect(statuses(s.run().state)).toEqual({ C1: 'completed', P1: 'resolved', P2: 'resolved' });
  });
});

describe('CC-2a engine: cursor, refs and ordering', () => {
  it('applies in ascending sequence, skips ≤ cursor, and a replay makes no transitions', () => {
    const s = new Script();
    s.say(alice, { type: 'question' });
    s.say(bob, { type: 'commitment' });
    const first = s.run(EMPTY_STATE, [...s.messages].reverse());
    expect(first.state.cursor).toBe(2);
    expect(statuses(first.state)).toEqual({ Q1: 'open', C1: 'open' });
    const replay = s.run(first.state);
    expect(replay.transitions).toEqual([]);
    expect(replay.state).toEqual(first.state);
  });

  it("excluded seats and chorus-verify proofs move the cursor but aren't applied", () => {
    const s = new Script();
    s.say(chorus, { type: 'question' });
    s.say(alice, { type: 'question' }, { content: 'chorus-verify 123456 (proof)' });
    const { state, transitions } = s.run(EMPTY_STATE, s.messages, [chorus.member_id]);
    expect(state).toEqual({ ...EMPTY_STATE, cursor: 2 });
    expect(transitions).toEqual([]);
    expect(s.rosters.size).toBe(0);
  });

  it('allocates refs from state.next per prefix, never reusing one', () => {
    const s = new Script(40);
    s.say(alice, [{ type: 'question' }, { type: 'commitment' }, { type: 'question' }]);
    const state: CoordState = { cursor: 40, next: { ...EMPTY_STATE.next, Q: 7 }, objects: [] };
    const result = s.run(state);
    expect(result.state.objects.map((o) => o.ref)).toEqual(['C1', 'Q7', 'Q8']);
    expect(result.state.next).toEqual({ ...EMPTY_STATE.next, Q: 9, C: 2 });
  });

  it('orders objects by created_seq, then ref, whatever the input order', () => {
    const s = new Script();
    s.say(alice, { type: 'question' });
    s.say(bob, [{ type: 'question' }, { type: 'commitment' }]);
    const once = s.run().state;
    const shuffled = { ...once, objects: [...once.objects].reverse() };
    s.say(carol, { type: 'answer', answers: 'Q1' });
    expect(s.run(shuffled).state.objects.map((o) => o.ref)).toEqual(['Q1', 'C1', 'Q2']);
  });

  it('is pure: deep-frozen state and messages give the same result as unfrozen ones', () => {
    const s = new Script();
    const h = s.say(alice, { type: 'handoff', targets: [bob] });
    s.say(bob, { type: 'acknowledgement' }, { reply: h });
    s.say(carol, { type: 'claim', subject: 'the api', predicate: 'healthy', polarity: 'pos' });
    const middle = s.run().state;
    s.say(dave, { type: 'claim', subject: 'the api', predicate: 'healthy', polarity: 'neg' });
    s.say(bob, { type: 'completion' });
    const expected = s.run(structuredClone(middle), structuredClone(s.messages));
    for (const events of s.events.values()) deepFreeze(events);
    const frozen = s.run(deepFreeze(middle), deepFreeze(s.messages));
    expect(frozen).toEqual(expected);
    expect(statuses(frozen.state)).toEqual({
      H1: 'completed',
      C1: 'completed',
      K1: 'active',
      K2: 'active',
      X1: 'detected',
    });
  });

  it('applyEvents is the per-message core', () => {
    const result = applyEvents(
      EMPTY_STATE,
      { message_id: 'm1', sequence: 5, sender: alice, reply_to_message_id: null },
      [
        {
          type: 'question',
          message_id: 'm1',
          sequence: 5,
          author: alice,
          text: 'Who owns the pipeline?',
          reply_to_message_id: null,
          refs: [],
          targets: [],
        },
      ],
    );
    expect(result.state.cursor).toBe(5);
    expect(result.state.objects).toEqual([
      {
        ref: 'Q1',
        kind: 'question',
        status: 'open',
        text: 'Who owns the pipeline?',
        author: alice,
        targets: [],
        related: [],
        sources: [{ message_id: 'm1', sequence: 5 }],
        created_seq: 5,
        touched_seq: 5,
      },
    ]);
  });
});

describe('CC-2a engine: roster', () => {
  it('is every member on an object plus the sender, by member id, with the latest name', () => {
    const s = new Script();
    s.say(alice, { type: 'handoff', targets: [carol] });
    s.say(bob, []);
    s.run();
    expect(s.rosters.get('msg_002')).toEqual([alice, bob, carol]);
    const renamed = { member_id: carol.member_id, name: 'caroline' };
    expect(rosterOf(s.run().state, renamed)).toEqual([alice, renamed]);
  });

  it('a member who has only sent messages that created nothing is NOT in the roster (split-invariant)', () => {
    // danny first speaks in a message that creates nothing; dana is on an object; then alice addresses "dan".
    // If earlier senders of the same call were in the roster, "dan" would be AMBIGUOUS in one call but resolve
    // to dana message by message. The roster comes from the state only, so both runs resolve it to dana.
    const s = new Script();
    s.say(danny, []);
    s.say(dana, { type: 'commitment' });
    s.say(alice, { type: 'handoff', mentions: ['dan'] });
    const batch = s.run().state;
    const batchRosters = new Map(s.rosters);
    let state = EMPTY_STATE;
    for (const message of s.messages) state = s.run(state, [message]).state;
    expect(state).toEqual(batch);
    expect(s.rosters).toEqual(batchRosters);
    expect(batchRosters.get('msg_003')?.map((m) => m.name)).toEqual(['alice', 'dana']);
    expect(find(batch, 'H1').targets).toEqual([dana]);
    // Once danny is on an object, "dan" is ambiguous and resolves to nobody.
    s.say(danny, { type: 'commitment' });
    s.say(alice, { type: 'handoff', mentions: ['dan'] });
    expect(find(s.run().state, 'H2').targets).toEqual([]);
  });
});

describe('CC-2a engine: one message at a time equals one call', () => {
  /**
   * A longer script touching every §4 rule, plus the roster hazards: `danny` first appears in a message that
   * creates nothing, and `danny`/`dana` share the prefix "dan", which is unique until both are on objects.
   */
  const script = (): Script => {
    const s = new Script();
    s.say(danny, []); // creates nothing
    s.say(dana, { type: 'commitment', text: 'I will draft the release notes' });
    s.say(alice, { type: 'handoff', mentions: ['dan'] }); // dana only: danny is on no object yet
    const q1 = s.say(alice, {
      type: 'question',
      targets: [bob],
      text: 'Which port does staging use?',
    });
    s.say(bob, { type: 'acknowledgement' }, { reply: q1 });
    const h1 = s.say(alice, {
      type: 'handoff',
      targets: [carol],
      text: 'carol, can you rotate keys?',
    });
    s.say(carol, { type: 'status_update' });
    s.say(
      bob,
      { type: 'claim', subject: 'staging port', predicate: '5432', polarity: 'pos' },
      { reply: q1 },
    );
    s.say(carol, { type: 'acknowledgement' }, { reply: h1 });
    s.say(dave, { type: 'commitment', text: 'I will update the runbook for the rotation' });
    s.say(danny, { type: 'commitment', text: 'I will update the rotation runbook today' });
    s.say(alice, { type: 'dependency', blocker: { member: carol } });
    s.say(dave, { type: 'claim', subject: 'staging port', predicate: '5432', polarity: 'neg' });
    s.say(carol, { type: 'status_update', refs: ['H1'] });
    s.say(carol, { type: 'completion', refs: ['C2'] });
    s.say(alice, { type: 'decision', subject: 'staging port', value: '6543' });
    s.say(bob, { type: 'question', text: 'which port does staging use' });
    s.say(dave, { type: 'withdrawal', refs: ['C3'] });
    s.say(alice, { type: 'handoff', targets: [danny] });
    s.say(danny, []);
    s.say(danny, { type: 'acknowledgement' });
    s.say(bob, { type: 'dependency', blocker: { member: danny } });
    s.say(danny, { type: 'dependency', blocker: { member: bob } });
    s.say(bob, { type: 'commitment', text: 'I will review the rotation' });
    s.say(danny, { type: 'dependency', blocker: { member: bob } });
    s.say(bob, { type: 'decline' });
    s.say(carol, { type: 'decision', subject: 'staging port', value: '5432' });
    s.say(alice, { type: 'handoff', targets: [bob], take_over: 'C9' });
    s.say(bob, { type: 'decline' });
    s.say(chorus, { type: 'question' });
    s.say(bob, { type: 'completion' });
    s.say(danny, { type: 'completion', refs: ['C4'] });
    s.say(alice, { type: 'answer', answers: 'Q2' });
    s.say(alice, { type: 'question', mentions: ['dan'] }); // now ambiguous: no target
    return s;
  };

  it('the batch run covers the script', () => {
    const { state } = script().run(EMPTY_STATE, undefined, [chorus.member_id]);
    const kinds = new Set(state.objects.map((o) => o.kind));
    expect([...kinds].sort()).toEqual([
      'claim',
      'commitment',
      'conflict',
      'decision',
      'dependency',
      'handoff',
      'question',
    ]);
    expect(state.cursor).toBe(34);
  });

  it('holds for 50 seeded random splits, rosters included', () => {
    const batchScript = script();
    const batch = batchScript.run(EMPTY_STATE, undefined, [chorus.member_id]);
    const random = seeded(20260927);
    for (let round = 0; round < 50; round += 1) {
      const s = script();
      let state = EMPTY_STATE;
      const transitions = [];
      let at = 0;
      while (at < s.messages.length) {
        const size = 1 + Math.floor(random() * 6);
        // Chunks may overlap earlier messages: the cursor must skip them.
        const from = Math.max(0, at - Math.floor(random() * 2));
        const chunk = s.messages.slice(from, at + size);
        const result = s.run(state, round % 2 === 0 ? chunk : [...chunk].reverse(), [
          chorus.member_id,
        ]);
        state = result.state;
        transitions.push(...result.transitions);
        at += size;
      }
      expect(state).toEqual(batch.state);
      expect(transitions).toEqual(batch.transitions);
      expect(s.rosters).toEqual(batchScript.rosters);
    }
  });
});
