/**
 * CC-2a coordination signals (spec §5): what needs attention in a session's inferred conversation state. Pure and
 * deterministic: signals are ordered by kind priority, then by the oldest `created_seq` among their objects, then
 * by their refs. Every signal is an inference about the conversation, never a statement about canonical work.
 */
import { byObjectOrder, compare } from './engine.ts';
import { contentTokens, jaccard } from './similarity.ts';
import {
  UNSETTLED_STATUSES,
  type CoordObject,
  type Evaluate,
  type Member,
  type Signal,
  type SignalKind,
} from './types.ts';

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

const UNANSWERED_AFTER = 12;
const MISSING_ACK_AFTER = 3;
const STALE_AFTER = 30;
/**
 * `dependency_resolved` means "resolved at or after the previous cursor", but a state does not remember its
 * previous cursor. A resolved dependency's `touched_seq` is the sequence of the message that resolved it (a
 * terminal object is never touched again), so the signal covers dependencies resolved within this many messages
 * of the cursor: the same horizon as an unanswered question.
 */
const RECENTLY_RESOLVED = 12;

const unsettled = (object: CoordObject): boolean =>
  UNSETTLED_STATUSES[object.kind].includes(object.status);
const isOpenCommitment = (object: CoordObject): boolean =>
  object.kind === 'commitment' && unsettled(object);
const ownerOf = (object: CoordObject): Member => object.owner ?? object.author;

export const evaluate: Evaluate = (state) => {
  const objects = [...state.objects].sort(byObjectOrder);
  const byRef = new Map(objects.map((object) => [object.ref, object]));
  const found: { signal: Signal; oldest: number }[] = [];
  const add = (
    kind: SignalKind,
    refs: readonly string[],
    members: readonly Member[],
    reason: string,
    action: string,
  ): void => {
    const seqs = refs.map((ref) => byRef.get(ref)?.created_seq ?? Infinity);
    found.push({
      signal: { kind, refs, members, reason, suggested_next_action: action },
      oldest: Math.min(Infinity, ...seqs),
    });
  };

  for (const [index, a] of objects.entries()) {
    switch (a.kind) {
      case 'conflict': {
        const [first, second] = a.related.map((ref) => byRef.get(ref));
        if (a.status !== 'detected' || first === undefined || second === undefined) break;
        add(
          'conflict',
          [a.ref, first.ref, second.ref],
          [first.author, second.author],
          'Two members made opposite claims about the same thing.',
          `Resolve conflict ${a.ref}: ${first.author.name} and ${second.author.name} disagree on "${a.subject ?? ''}". Settle it in the room, or record a decision.`,
        );
        break;
      }
      case 'decision': {
        if (a.status !== 'active' || a.subject === undefined) break;
        for (const claim of objects) {
          if (claim.kind !== 'claim' || claim.status !== 'active' || claim.hedged === true)
            continue;
          if (jaccard(contentTokens(claim.subject ?? ''), contentTokens(a.subject)) < 0.8) continue;
          const opposite = (claim.polarity ?? 'pos') !== (a.polarity ?? 'pos');
          const differentValue =
            a.value !== undefined &&
            jaccard(contentTokens(claim.predicate ?? ''), contentTokens(a.value)) < 0.5;
          if (!opposite && !differentValue) continue;
          add(
            'decision_contradicted',
            [claim.ref, a.ref],
            [claim.author, a.author],
            'An active claim disagrees with an active decision.',
            `Claim ${claim.ref} by ${claim.author.name} contradicts decision ${a.ref}. Confirm the decision or supersede it.`,
          );
        }
        break;
      }
      case 'commitment': {
        if (!isOpenCommitment(a)) break;
        const tokens = contentTokens(a.text);
        if (STALE_AFTER <= state.cursor - a.touched_seq) {
          const n = state.cursor - a.touched_seq;
          add(
            'stale_commitment',
            [a.ref],
            [ownerOf(a)],
            'An open commitment has had no update for a while.',
            `${ownerOf(a).name}'s commitment ${a.ref} has had no update for ${String(n)} messages. Update, complete or withdraw it.`,
          );
        }
        if (tokens.length < 3) break;
        for (const b of objects.slice(index + 1)) {
          if (!isOpenCommitment(b) || ownerOf(b).member_id === ownerOf(a).member_id) continue;
          const other = contentTokens(b.text);
          if (other.length < 3 || jaccard(tokens, other) < 0.5) continue;
          add(
            'duplicate_commitments',
            [a.ref, b.ref],
            [ownerOf(a), ownerOf(b)],
            'Two members committed to similar work.',
            `${ownerOf(a).name} and ${ownerOf(b).name} both committed to similar work (${a.ref}, ${b.ref}). Create one task and link both, or split the work.`,
          );
        }
        break;
      }
      case 'dependency': {
        const blocker = byRef.get(a.related[0] ?? '');
        if (
          a.status !== 'resolved' ||
          blocker === undefined ||
          state.cursor - a.touched_seq >= RECENTLY_RESOLVED
        )
          break;
        add(
          'dependency_resolved',
          [a.ref, blocker.ref],
          [a.author],
          'What a member was waiting on is settled.',
          `${a.author.name}: ${a.ref} is unblocked, because ${blocker.ref} is ${blocker.status}.`,
        );
        break;
      }
      case 'question':
        if (a.status === 'open' && state.cursor - a.created_seq >= UNANSWERED_AFTER)
          add(
            'unanswered_question',
            [a.ref],
            [a.author],
            'A question has had no answer for a while.',
            `Unanswered question ${a.ref} from ${a.author.name}. Answer it, or create a task and link it.`,
          );
        break;
      case 'handoff': {
        // A pending handoff's sources after the first are exactly its targets' later messages (engine.ts).
        const target = a.targets[0];
        if (a.status === 'pending' && target !== undefined)
          if (a.sources.length - 1 >= MISSING_ACK_AFTER)
            add(
              'missing_acknowledgement',
              [a.ref],
              [target, a.author],
              'The target of a handoff kept talking without acknowledging it.',
              `${target.name} hasn't acknowledged handoff ${a.ref} from ${a.author.name}.`,
            );
        break;
      }
      case 'claim':
        break;
    }
  }

  for (const cycle of deadlocks(objects)) {
    const names = [...cycle.members, cycle.members[0]].map((member) => member?.name ?? '');
    add(
      'dependency_deadlock',
      cycle.refs,
      cycle.members,
      'Members are waiting on each other in a cycle.',
      `Deadlock: ${names.join(' waits on ')}. One of you must go first.`,
    );
  }

  if (objects.length > 0 && !objects.some(unsettled))
    add(
      'ready_to_close',
      [],
      [],
      'Nothing tracked in this conversation is open.',
      'Everything tracked in this conversation is settled. Nothing is open.',
    );

  return found
    .sort(
      (a, b) =>
        PRIORITY.indexOf(a.signal.kind) - PRIORITY.indexOf(b.signal.kind) ||
        a.oldest - b.oldest ||
        compare(a.signal.refs.join(','), b.signal.refs.join(',')),
    )
    .map((entry) => entry.signal);
};

/**
 * Every elementary cycle of the waits-on graph (waiting dependency: its author → the member it waits on), each
 * reported once, rotated to start at its smallest member id. Edges between the same two members use the oldest
 * dependency. The graph has one node per member, so enumerating cycles from each smallest node is cheap.
 */
function deadlocks(
  objects: readonly CoordObject[],
): { readonly members: readonly Member[]; readonly refs: readonly string[] }[] {
  const edges = new Map<string, Map<string, string>>();
  const members = new Map<string, Member>();
  for (const dependency of objects) {
    const to = dependency.targets[0];
    const from = dependency.author;
    if (dependency.kind !== 'dependency' || dependency.status !== 'waiting' || to === undefined)
      continue;
    if (from.member_id === to.member_id) continue;
    members.set(from.member_id, members.get(from.member_id) ?? from);
    members.set(to.member_id, members.get(to.member_id) ?? to);
    const out = edges.get(from.member_id) ?? new Map<string, string>();
    if (!out.has(to.member_id)) out.set(to.member_id, dependency.ref);
    edges.set(from.member_id, out);
  }
  const ids = [...members.keys()].sort(compare);
  const cycles: { members: Member[]; refs: string[] }[] = [];
  for (const start of ids) {
    const walk = (node: string, path: string[], refs: string[]): void => {
      for (const [to, ref] of [...(edges.get(node) ?? [])].sort(([a], [b]) => compare(a, b))) {
        if (to === start) {
          cycles.push({
            members: path.map((id) => members.get(id) ?? { member_id: id, name: id }),
            refs: [...refs, ref],
          });
        } else if (to > start && !path.includes(to)) {
          walk(to, [...path, to], [...refs, ref]);
        }
      }
    };
    walk(start, [start], []);
  }
  return cycles;
}
