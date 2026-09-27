/**
 * CC-2a §5: literal-`CoordState` unit tests for `evaluate`, covering cases that are easier and more reliable
 * to construct as data than to engineer through natural-language messages: exact age-threshold boundaries,
 * and a multi-member dependency deadlock cycle. The NL acceptance fixture (`coordination-fixture.test.ts`)
 * covers every other row of §5 through realistic conversation.
 */
import { describe, expect, it } from 'vitest';
import { evaluate, type CoordObject, type CoordState, type Member } from '../../src/index.ts';

const alice: Member = { member_id: 'i_alice', name: 'alice' };
const bob: Member = { member_id: 'i_bob', name: 'bob' };
const carol: Member = { member_id: 'i_carol', name: 'carol' };

let refCounter = 0;
function object(
  over: Partial<CoordObject> & Pick<CoordObject, 'kind' | 'status' | 'author'>,
): CoordObject {
  refCounter += 1;
  return {
    ref: `T${String(refCounter)}`,
    text: 'placeholder text with enough tokens to count',
    targets: [],
    related: [],
    sources: [{ message_id: `m${String(refCounter)}`, sequence: 1 }],
    created_seq: 1,
    touched_seq: 1,
    ...over,
  };
}

function stateOf(objects: CoordObject[], cursor: number): CoordState {
  return { cursor, next: { Q: 1, C: 1, H: 1, D: 1, K: 1, X: 1, P: 1 }, objects };
}

describe('evaluate: exact age thresholds (spec §5)', () => {
  it('unanswered_question fires at cursor - created_seq === 12, not at 11', () => {
    const q = object({ kind: 'question', status: 'open', author: alice, created_seq: 10 });
    expect(evaluate(stateOf([q], 21)).some((s) => s.kind === 'unanswered_question')).toBe(false);
    expect(evaluate(stateOf([q], 22)).some((s) => s.kind === 'unanswered_question')).toBe(true);
  });

  it('stale_commitment fires at cursor - touched_seq === 30, not at 29', () => {
    const c = object({
      kind: 'commitment',
      status: 'open',
      author: bob,
      owner: bob,
      created_seq: 5,
      touched_seq: 5,
    });
    expect(evaluate(stateOf([c], 34)).some((s) => s.kind === 'stale_commitment')).toBe(false);
    expect(evaluate(stateOf([c], 35)).some((s) => s.kind === 'stale_commitment')).toBe(true);
  });

  it('missing_acknowledgement fires once the target has 3 messages after the handoff, not at 2', () => {
    const handoff = object({
      kind: 'handoff',
      status: 'pending',
      author: alice,
      targets: [bob],
      created_seq: 1,
    });
    const messagesAfter = (n: number): CoordObject[] =>
      Array.from({ length: n }, (_, i) =>
        object({
          kind: 'claim',
          status: 'active',
          author: bob,
          created_seq: 2 + i,
          touched_seq: 2 + i,
        }),
      );
    expect(
      evaluate(stateOf([handoff, ...messagesAfter(2)], 10)).some(
        (s) => s.kind === 'missing_acknowledgement',
      ),
    ).toBe(false);
    expect(
      evaluate(stateOf([handoff, ...messagesAfter(3)], 10)).some(
        (s) => s.kind === 'missing_acknowledgement',
      ),
    ).toBe(true);
  });

  it('duplicate_commitments requires each commitment to have at least 3 content tokens', () => {
    const short1 = object({
      kind: 'commitment',
      status: 'open',
      author: bob,
      owner: bob,
      text: 'fix it',
    });
    const short2 = object({
      kind: 'commitment',
      status: 'open',
      author: carol,
      owner: carol,
      text: 'fix it',
    });
    expect(
      evaluate(stateOf([short1, short2], 1)).some((s) => s.kind === 'duplicate_commitments'),
    ).toBe(false);
    const long1 = object({
      kind: 'commitment',
      status: 'open',
      author: bob,
      owner: bob,
      text: 'fix the login redirect bug today',
    });
    const long2 = object({
      kind: 'commitment',
      status: 'open',
      author: carol,
      owner: carol,
      text: 'fix the login redirect bug now',
    });
    expect(
      evaluate(stateOf([long1, long2], 1)).some((s) => s.kind === 'duplicate_commitments'),
    ).toBe(true);
  });

  it('dependency_resolved only fires for a dependency resolved at the current cursor, not an older one', () => {
    const blocker = object({ kind: 'commitment', status: 'completed', author: bob, owner: bob });
    const staleResolved = object({
      kind: 'dependency',
      status: 'resolved',
      author: alice,
      related: [blocker.ref],
      created_seq: 1,
      touched_seq: 5,
    });
    // The state's cursor has since moved well past when this dependency actually resolved.
    expect(
      evaluate(stateOf([blocker, staleResolved], 20)).some((s) => s.kind === 'dependency_resolved'),
    ).toBe(false);
    const freshResolved = object({
      kind: 'dependency',
      status: 'resolved',
      author: alice,
      related: [blocker.ref],
      created_seq: 1,
      touched_seq: 20,
    });
    expect(
      evaluate(stateOf([blocker, freshResolved], 20)).some((s) => s.kind === 'dependency_resolved'),
    ).toBe(true);
  });
});

describe('evaluate: dependency_deadlock (spec §5)', () => {
  it('reports a two-member wait cycle exactly once', () => {
    // alice's commitment blocks bob's dependency; bob's commitment blocks alice's dependency.
    const aliceCommitment = object({
      kind: 'commitment',
      status: 'open',
      author: alice,
      owner: alice,
    });
    const bobCommitment = object({ kind: 'commitment', status: 'open', author: bob, owner: bob });
    const bobWaitsOnAlice = object({
      kind: 'dependency',
      status: 'waiting',
      author: bob,
      related: [aliceCommitment.ref],
    });
    const aliceWaitsOnBob = object({
      kind: 'dependency',
      status: 'waiting',
      author: alice,
      related: [bobCommitment.ref],
    });
    const signals = evaluate(
      stateOf([aliceCommitment, bobCommitment, bobWaitsOnAlice, aliceWaitsOnBob], 1),
    ).filter((s) => s.kind === 'dependency_deadlock');
    expect(signals).toHaveLength(1);
    expect(new Set(signals[0]?.members.map((m) => m.member_id))).toEqual(
      new Set([alice.member_id, bob.member_id]),
    );
  });

  it('reports a three-member wait cycle', () => {
    const aliceCommitment = object({
      kind: 'commitment',
      status: 'open',
      author: alice,
      owner: alice,
    });
    const bobCommitment = object({ kind: 'commitment', status: 'open', author: bob, owner: bob });
    const carolCommitment = object({
      kind: 'commitment',
      status: 'open',
      author: carol,
      owner: carol,
    });
    const aliceWaitsOnBob = object({
      kind: 'dependency',
      status: 'waiting',
      author: alice,
      related: [bobCommitment.ref],
    });
    const bobWaitsOnCarol = object({
      kind: 'dependency',
      status: 'waiting',
      author: bob,
      related: [carolCommitment.ref],
    });
    const carolWaitsOnAlice = object({
      kind: 'dependency',
      status: 'waiting',
      author: carol,
      related: [aliceCommitment.ref],
    });
    const signals = evaluate(
      stateOf(
        [
          aliceCommitment,
          bobCommitment,
          carolCommitment,
          aliceWaitsOnBob,
          bobWaitsOnCarol,
          carolWaitsOnAlice,
        ],
        1,
      ),
    ).filter((s) => s.kind === 'dependency_deadlock');
    expect(signals).toHaveLength(1);
    expect(new Set(signals[0]?.members.map((m) => m.member_id))).toEqual(
      new Set([alice.member_id, bob.member_id, carol.member_id]),
    );
  });

  it('a waiting dependency with no cycle produces no deadlock signal', () => {
    const bobCommitment = object({ kind: 'commitment', status: 'open', author: bob, owner: bob });
    const aliceWaitsOnBob = object({
      kind: 'dependency',
      status: 'waiting',
      author: alice,
      related: [bobCommitment.ref],
    });
    const signals = evaluate(stateOf([bobCommitment, aliceWaitsOnBob], 1)).filter(
      (s) => s.kind === 'dependency_deadlock',
    );
    expect(signals).toEqual([]);
  });
});

describe('evaluate: ready_to_close (spec §5)', () => {
  it('fires when at least one object exists and nothing is unsettled', () => {
    const closedQuestion = object({ kind: 'question', status: 'answered', author: alice });
    expect(evaluate(stateOf([closedQuestion], 1)).some((s) => s.kind === 'ready_to_close')).toBe(
      true,
    );
  });

  it('never fires on an empty state', () => {
    expect(evaluate(stateOf([], 0)).some((s) => s.kind === 'ready_to_close')).toBe(false);
  });

  it('does not fire while any commitment, question, handoff, conflict or dependency is unsettled', () => {
    const openCommitment = object({ kind: 'commitment', status: 'open', author: bob, owner: bob });
    expect(evaluate(stateOf([openCommitment], 1)).some((s) => s.kind === 'ready_to_close')).toBe(
      false,
    );
  });
});
