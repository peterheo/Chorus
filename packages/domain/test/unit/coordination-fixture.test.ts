/**
 * CC-2a §6: the required ≥40-message acceptance fixture. Every row of §3–§5 is exercised at least once,
 * including the negative cases the spec names explicitly. Assertions are exact: ref, status, owner/author,
 * `related`, and the signals `evaluate` produces from the resulting state.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyMessages,
  evaluate,
  EMPTY_STATE,
  type CoordObject,
  type CoordState,
  type SourceMessage,
} from '../../src/index.ts';

const fixturePath = fileURLToPath(new URL('./coordination-fixture.json', import.meta.url));
const messages: SourceMessage[] = JSON.parse(readFileSync(fixturePath, 'utf8')) as SourceMessage[];

const ctx = { excludeMemberIds: [] };

function byRef(objects: readonly CoordObject[], ref: string): CoordObject {
  const found = objects.find((o) => o.ref === ref);
  if (found === undefined) throw new Error(`fixture: expected object ${ref} to exist`);
  return found;
}

describe('CC-2a coordination fixture (spec §6)', () => {
  it('has at least 40 labelled messages across alice, bob, carol and dave', () => {
    expect(messages.length).toBeGreaterThanOrEqual(40);
    const senders = new Set(messages.map((m) => m.sender_name));
    expect(senders).toEqual(new Set(['alice', 'bob', 'carol', 'dave', 'alina']));
    expect(messages.length).toBe(62);
  });

  const { state } = applyMessages(EMPTY_STATE, messages, ctx);

  it('Q1/C1: a question answered by reply, a commitment completed by reply (§4 question, commitment)', () => {
    const q1 = byRef(state.objects, 'Q1');
    expect(q1.status).toBe('answered');
    expect(q1.author.name).toBe('alice');
    const c1 = byRef(state.objects, 'C1');
    expect(c1.status).toBe('completed');
    expect(c1.owner?.name).toBe('bob');
  });

  it('Q2: a medium question left open (§3 question)', () => {
    expect(byRef(state.objects, 'Q2').status).toBe('open');
  });

  it('H1/C3: a handoff accepted by explicit reply, creating a linked commitment (§4 handoff)', () => {
    const h1 = byRef(state.objects, 'H1');
    expect(h1.status).toBe('accepted');
    expect(h1.targets.map((t) => t.name)).toEqual(['dave']);
    const c3 = byRef(state.objects, 'C3');
    expect(c3.owner?.name).toBe('dave');
    expect(c3.related).toEqual(['H1']);
    // The linked commitment completes via a reply to the acceptance message, which also completes H1.
    expect(c3.status).toBe('completed');
  });

  it('H2: a handoff declined (§4 handoff decline)', () => {
    const h2 = byRef(state.objects, 'H2');
    expect(h2.status).toBe('declined');
    expect(h2.targets.map((t) => t.name)).toEqual(['bob']);
  });

  it('C4: a commitment withdrawn (§4 commitment withdrawal)', () => {
    expect(byRef(state.objects, 'C4').status).toBe('withdrawn');
  });

  it('D1/D2: a decision superseded by a later same-subject decision (§4 decision)', () => {
    const d1 = byRef(state.objects, 'D1');
    const d2 = byRef(state.objects, 'D2');
    expect(d1.status).toBe('superseded');
    expect(d1.related).toEqual(['D2']);
    expect(d2.status).toBe('active');
    expect(d2.related).toEqual(['D1']);
  });

  it('K2/D2: an active claim contradicting an active decision (§5 decision_contradicted)', () => {
    const k2 = byRef(state.objects, 'K2');
    expect(k2.status).toBe('active');
    expect(k2.polarity).toBe('neg');
    const signal = evaluate(state).find((s) => s.kind === 'decision_contradicted');
    expect(signal?.refs).toEqual(['K2', 'D2']);
  });

  it('K3/K4/X1: two opposite-polarity claims on the same subject conflict (§4 conflict)', () => {
    const x1 = byRef(state.objects, 'X1');
    expect(x1.status).toBe('detected');
    expect([...x1.related].sort()).toEqual(['K3', 'K4']);
    const signal = evaluate(state).find((s) => s.kind === 'conflict');
    expect(signal?.refs).toEqual(['X1']);
  });

  it('K6/K7: a conditional claim vs one without the condition does NOT conflict (§6 negative case)', () => {
    const conflicts = state.objects.filter((o) => o.kind === 'conflict');
    const involvesK6orK7 = conflicts.some(
      (c) => c.related.includes('K6') || c.related.includes('K7'),
    );
    expect(involvesK6orK7).toBe(false);
  });

  it('K8 vs K3/K4: a hedged claim never conflicts, even matching subject/predicate (§6 negative case)', () => {
    const k8 = byRef(state.objects, 'K8');
    expect(k8.hedged).toBe(true);
    const conflicts = state.objects.filter((o) => o.kind === 'conflict');
    expect(conflicts.some((c) => c.related.includes('K8'))).toBe(false);
  });

  it('"I can\'t look at it" creates no commitment (§6 negative case)', () => {
    const noBandwidth = state.objects.find(
      (o) => o.kind === 'commitment' && o.text.includes("I can't look at it"),
    );
    expect(noBandwidth).toBeUndefined();
  });

  it('H3: "ok" replying to an unrelated message does NOT accept a pending handoff (§6 negative case)', () => {
    const h3 = byRef(state.objects, 'H3');
    expect(h3.status).toBe('pending');
  });

  it('Q5: an ambiguous name prefix ("Ali" vs alice/alina) resolves to no target (§6 negative case)', () => {
    const q5 = byRef(state.objects, 'Q5');
    expect(q5.kind).toBe('question');
    expect(q5.targets).toEqual([]);
    expect(
      state.objects.some((o) => o.kind === 'handoff' && o.text.includes('check the logs')),
    ).toBe(false);
  });

  it("P1: a dependency resolves once its blocker (a named member's open commitment) completes (§4 dependency)", () => {
    const p1 = byRef(state.objects, 'P1');
    expect(p1.status).toBe('resolved');
    expect(p1.related).toEqual(['C6']);
    expect(byRef(state.objects, 'C6').status).toBe('completed');
  });

  it('no blocker found creates no dependency (§6 negative case)', () => {
    const noBlocker = state.objects.find(
      (o) => o.kind === 'dependency' && o.text.includes('waiting for someone to reply'),
    );
    expect(noBlocker).toBeUndefined();
  });

  it('Q6: a repeated question (Jaccard ≥ 0.8) against an answered one links back (§4 question)', () => {
    const q6 = byRef(state.objects, 'Q6');
    expect(q6.related).toEqual(['Q1']);
  });

  it('C7/C8: two different owners committing to similar work (§5 duplicate_commitments)', () => {
    const signal = evaluate(state).find((s) => s.kind === 'duplicate_commitments');
    expect([...(signal?.refs ?? [])].sort()).toEqual(['C7', 'C8']);
    expect(signal?.members.map((m) => m.name).sort()).toEqual(['bob', 'dave']);
  });

  it('C5: an open commitment untouched for ≥ 30 messages is stale (§5 stale_commitment)', () => {
    const signal = evaluate(state).find((s) => s.kind === 'stale_commitment');
    expect(signal?.refs).toEqual(['C5']);
  });

  it('unanswered questions open ≥ 12 messages are all reported, oldest first (§5 unanswered_question)', () => {
    const signals = evaluate(state).filter((s) => s.kind === 'unanswered_question');
    const refs = signals.map((s) => s.refs[0]);
    expect(refs).toEqual(['Q2', 'Q4', 'Q5', 'Q6', 'Q7']);
  });

  it('signals are ordered by kind priority, then oldest created_seq (§5)', () => {
    const kinds = evaluate(state).map((s) => s.kind);
    const priority = [
      'conflict',
      'decision_contradicted',
      'duplicate_commitments',
      'dependency_resolved',
      'dependency_deadlock',
      'unanswered_question',
      'missing_acknowledgement',
      'stale_commitment',
      'ready_to_close',
    ];
    const positions = kinds.map((k) => priority.indexOf(k));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('a replay of the same messages produces no new transitions (§6 monotonic cursor)', () => {
    const { state: replayed, transitions } = applyMessages(state, messages, ctx);
    expect(transitions).toEqual([]);
    expect(replayed).toEqual(state);
  });

  it('a deep-frozen input still produces the correct output (§6 purity)', () => {
    function deepFreeze<T>(value: T): T {
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          deepFreeze(record[key]);
        }
        Object.freeze(value);
      }
      return value;
    }
    const frozenState: CoordState = deepFreeze(
      JSON.parse(JSON.stringify(EMPTY_STATE)) as CoordState,
    );
    const frozenMessages = deepFreeze(JSON.parse(JSON.stringify(messages)) as SourceMessage[]);
    const frozenCtx = deepFreeze({ excludeMemberIds: [] as string[] });
    expect(() => applyMessages(frozenState, frozenMessages, frozenCtx)).not.toThrow();
    const { state: fromFrozen } = applyMessages(frozenState, frozenMessages, frozenCtx);
    expect(fromFrozen).toEqual(state);
  });

  it('applying messages one at a time equals applying them in one call (§6 property test)', () => {
    let chained = EMPTY_STATE;
    for (const message of messages) {
      chained = applyMessages(chained, [message], ctx).state;
    }
    expect(chained).toEqual(state);
  });
});
