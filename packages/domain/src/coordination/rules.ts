/**
 * CC-2 §5: `evaluate`, the pure signal evaluator. It only reads `state`; it never mutates it or the engine.
 * Signals are evidence for a human or agent to act on (`room_pulse.next_actions` / `chorus.coordination_status`
 * in CC-2c); they never change canonical work themselves.
 */
import type { CoordObject, CoordState, Evaluate, Member, Signal, SignalKind } from './types.ts';
import { jaccard, contentTokens } from './similarity.ts';

const UNANSWERED_AGE = 12;
const STALE_AGE = 30;
const DUPLICATE_ACTION = 0.5;
const DUPLICATE_MIN_TOKENS = 3;

const PRIORITY: readonly SignalKind[] = [
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

const owner = (object: CoordObject): Member => object.owner ?? object.author;

function byOldestCreated(objects: readonly CoordObject[]): CoordObject[] {
  return [...objects].sort((a, b) => a.created_seq - b.created_seq);
}

function conflictSignals(objects: readonly CoordObject[]): Signal[] {
  return byOldestCreated(
    objects.filter((o) => o.kind === 'conflict' && o.status === 'detected'),
  ).map((conflict) => {
    const [refA, refB] = conflict.related;
    const claims = objects.filter((o) => conflict.related.includes(o.ref));
    const [a, b] = claims;
    return {
      kind: 'conflict',
      refs: [conflict.ref],
      members: claims.map((c) => c.author),
      reason: `${refA ?? ''} and ${refB ?? ''} disagree`,
      suggested_next_action: `Resolve conflict ${conflict.ref}: ${a?.author.name ?? ''} and ${b?.author.name ?? ''} disagree on "${a?.subject ?? ''}". Settle it in the room, or record a decision.`,
    };
  });
}

function decisionContradictedSignals(objects: readonly CoordObject[]): Signal[] {
  const decisions = objects.filter((o) => o.kind === 'decision' && o.status === 'active');
  const claims = byOldestCreated(
    objects.filter((o) => o.kind === 'claim' && o.status === 'active' && o.hedged !== true),
  );
  const signals: Signal[] = [];
  for (const claim of claims) {
    for (const decision of decisions) {
      if (jaccard(contentTokens(claim.subject ?? ''), contentTokens(decision.subject ?? '')) < 0.8)
        continue;
      const contradicts =
        claim.polarity === 'neg' ||
        (decision.value !== undefined &&
          jaccard(contentTokens(claim.predicate ?? ''), contentTokens(decision.value)) < 0.8);
      if (!contradicts) continue;
      signals.push({
        kind: 'decision_contradicted',
        refs: [claim.ref, decision.ref],
        members: [claim.author],
        reason: `${claim.ref} contradicts ${decision.ref}`,
        suggested_next_action: `Claim ${claim.ref} by ${claim.author.name} contradicts decision ${decision.ref}. Confirm the decision or supersede it.`,
      });
    }
  }
  return signals;
}

function duplicateCommitmentSignals(objects: readonly CoordObject[]): Signal[] {
  const commitments = byOldestCreated(
    objects.filter(
      (o) => o.kind === 'commitment' && (o.status === 'open' || o.status === 'in_progress'),
    ),
  );
  const signals: Signal[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < commitments.length; i++) {
    const a = commitments[i];
    if (a === undefined) continue;
    const tokensA = contentTokens(a.text);
    if (tokensA.length < DUPLICATE_MIN_TOKENS) continue;
    for (let j = i + 1; j < commitments.length; j++) {
      const b = commitments[j];
      if (b === undefined) continue;
      if (owner(a).member_id === owner(b).member_id) continue;
      const tokensB = contentTokens(b.text);
      if (tokensB.length < DUPLICATE_MIN_TOKENS) continue;
      if (jaccard(tokensA, tokensB) < DUPLICATE_ACTION) continue;
      const key = [a.ref, b.ref].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({
        kind: 'duplicate_commitments',
        refs: [a.ref, b.ref],
        members: [owner(a), owner(b)],
        reason: `${a.ref} and ${b.ref} look like the same work`,
        suggested_next_action: `${owner(a).name} and ${owner(b).name} both committed to similar work (${a.ref}, ${b.ref}). Create one task and link both, or split the work.`,
      });
    }
  }
  return signals;
}

function dependencyResolvedSignals(objects: readonly CoordObject[], cursor: number): Signal[] {
  return byOldestCreated(
    objects.filter(
      (o) => o.kind === 'dependency' && o.status === 'resolved' && cursor - o.touched_seq <= 0,
    ),
  ).map((dependency) => {
    const blocker = objects.find((o) => dependency.related.includes(o.ref));
    return {
      kind: 'dependency_resolved',
      refs: [dependency.ref],
      members: [dependency.author],
      reason: `${dependency.ref} unblocked`,
      suggested_next_action: `${dependency.author.name}: ${dependency.ref} is unblocked, because ${blocker?.ref ?? ''} is ${blocker?.status ?? ''}.`,
    };
  });
}

/** A cycle in the members'-wait graph: `waiting` dependency author waits on its blocker's owner. */
function dependencyDeadlockSignals(objects: readonly CoordObject[]): Signal[] {
  const waiting = objects.filter((o) => o.kind === 'dependency' && o.status === 'waiting');
  const edges = new Map<string, { to: string; member: Member; via: CoordObject }[]>();
  for (const dependency of waiting) {
    const blocker = objects.find((o) => dependency.related.includes(o.ref));
    if (blocker === undefined) continue;
    const from = dependency.author.member_id;
    const to = owner(blocker).member_id;
    const list = edges.get(from) ?? [];
    list.push({ to, member: dependency.author, via: dependency });
    edges.set(from, list);
  }
  const signals: Signal[] = [];
  const reported = new Set<string>();
  for (const start of edges.keys()) {
    const path: { member: Member; via: CoordObject }[] = [];
    const visited = new Set<string>();
    let current = start;
    for (;;) {
      const options = edges.get(current);
      const step = options?.[0];
      if (step === undefined) break;
      path.push({ member: step.member, via: step.via });
      if (step.to === start) {
        const key = [...new Set(path.map((p) => p.member.member_id))].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          const names = [...path.map((p) => p.member.name), path[0]?.member.name ?? ''];
          signals.push({
            kind: 'dependency_deadlock',
            refs: path.map((p) => p.via.ref),
            members: path.map((p) => p.member),
            reason: 'a wait cycle',
            suggested_next_action: `Deadlock: ${names.join(' waits on ')}. One of you must go first.`,
          });
        }
        break;
      }
      if (visited.has(step.to)) break;
      visited.add(step.to);
      current = step.to;
    }
  }
  return signals;
}

function unansweredQuestionSignals(objects: readonly CoordObject[], cursor: number): Signal[] {
  return byOldestCreated(
    objects.filter(
      (o) =>
        o.kind === 'question' && o.status === 'open' && cursor - o.created_seq >= UNANSWERED_AGE,
    ),
  ).map((question) => ({
    kind: 'unanswered_question',
    refs: [question.ref],
    members: [question.author],
    reason: `${question.ref} open for ${String(cursor - question.created_seq)} messages`,
    suggested_next_action: `Unanswered question ${question.ref} from ${question.author.name}. Answer it, or create a task and link it.`,
  }));
}

function missingAcknowledgementSignals(objects: readonly CoordObject[]): Signal[] {
  return byOldestCreated(
    objects.filter((o) => o.kind === 'handoff' && o.status === 'pending'),
  ).flatMap((handoff) => {
    const target = handoff.targets[0];
    if (target === undefined) return [];
    const messagesAfter = objects.filter(
      (o) => o.author.member_id === target.member_id && o.created_seq > handoff.created_seq,
    ).length;
    if (messagesAfter < 3) return [];
    return [
      {
        kind: 'missing_acknowledgement' as const,
        refs: [handoff.ref],
        members: [target, handoff.author],
        reason: `${target.name} has not acknowledged ${handoff.ref}`,
        suggested_next_action: `${target.name} hasn't acknowledged handoff ${handoff.ref} from ${handoff.author.name}.`,
      },
    ];
  });
}

function staleCommitmentSignals(objects: readonly CoordObject[], cursor: number): Signal[] {
  return byOldestCreated(
    objects.filter(
      (o) =>
        o.kind === 'commitment' &&
        (o.status === 'open' || o.status === 'in_progress') &&
        cursor - o.touched_seq >= STALE_AGE,
    ),
  ).map((commitment) => ({
    kind: 'stale_commitment',
    refs: [commitment.ref],
    members: [owner(commitment)],
    reason: `${commitment.ref} untouched for ${String(cursor - commitment.touched_seq)} messages`,
    suggested_next_action: `${owner(commitment).name}'s commitment ${commitment.ref} has had no update for ${String(cursor - commitment.touched_seq)} messages. Update, complete or withdraw it.`,
  }));
}

function readyToCloseSignal(objects: readonly CoordObject[]): Signal[] {
  if (objects.length === 0) return [];
  const openQuestions = objects.some(
    (o) => o.kind === 'question' && (o.status === 'open' || o.status === 'acknowledged'),
  );
  const openCommitments = objects.some(
    (o) => o.kind === 'commitment' && (o.status === 'open' || o.status === 'in_progress'),
  );
  const pendingHandoffs = objects.some((o) => o.kind === 'handoff' && o.status === 'pending');
  const detectedConflicts = objects.some((o) => o.kind === 'conflict' && o.status === 'detected');
  const waitingDependencies = objects.some(
    (o) => o.kind === 'dependency' && o.status === 'waiting',
  );
  if (
    openQuestions ||
    openCommitments ||
    pendingHandoffs ||
    detectedConflicts ||
    waitingDependencies
  )
    return [];
  return [
    {
      kind: 'ready_to_close',
      refs: [],
      members: [],
      reason: 'nothing open',
      suggested_next_action: 'Everything tracked in this conversation is settled. Nothing is open.',
    },
  ];
}

export const evaluate: Evaluate = (state: CoordState): readonly Signal[] => {
  const { objects, cursor } = state;
  const byKind: Record<SignalKind, Signal[]> = {
    conflict: conflictSignals(objects),
    decision_contradicted: decisionContradictedSignals(objects),
    duplicate_commitments: duplicateCommitmentSignals(objects),
    dependency_resolved: dependencyResolvedSignals(objects, cursor),
    dependency_deadlock: dependencyDeadlockSignals(objects),
    unanswered_question: unansweredQuestionSignals(objects, cursor),
    missing_acknowledgement: missingAcknowledgementSignals(objects),
    stale_commitment: staleCommitmentSignals(objects, cursor),
    ready_to_close: readyToCloseSignal(objects),
  };
  return PRIORITY.flatMap((kind) => byKind[kind]);
};
