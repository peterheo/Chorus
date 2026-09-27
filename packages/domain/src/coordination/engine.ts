/**
 * CC-2 §4: `applyMessages`, the pure state-machine core of the coordination engine. It takes a `CoordState`
 * and a window of messages and returns the next state plus the transitions that occurred. No I/O, no clock,
 * no mutation of its input (deep-frozen inputs are fine).
 *
 * Member resolution design note (not in the frozen `CoordState` schema, so stated here): a name can resolve
 * to a member who has authored, owned, or been targeted by a tracked object (recovered from `state.objects`
 * on every call), or who sent an earlier message within THIS call. A member who has never done either is not
 * resolvable — the same rule applies whether messages arrive in one call or one at a time, which is what
 * makes the two equivalent (the property CC-2a's fixture test asserts).
 */
import {
  EMPTY_STATE,
  REF_PREFIX,
  UNSETTLED_STATUSES,
  type ApplyContext,
  type ApplyMessages,
  type ApplyResult,
  type CoordObject,
  type CoordState,
  type Member,
  type ObjectKind,
  type RefPrefix,
  type Transition,
} from './types.ts';
import { extractEvents, type ExtractedEvent, type RawTarget } from './extract.ts';
import { jaccard, contentTokens, textSimilarity } from './similarity.ts';
import type { SourceMessage } from '../conversation/extract.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type WorkingObject = Mutable<CoordObject> & {
  targets: Member[];
  related: string[];
  sources: { message_id: string; sequence: number }[];
};

const SIMILAR = 0.8;

class Roster {
  private readonly byId = new Map<string, string>();

  see(member: Member): void {
    this.byId.set(member.member_id, member.name);
  }

  resolve(name: string): Member | undefined {
    const exactId = this.byId.get(name);
    if (exactId !== undefined) return { member_id: name, name: exactId };
    const lower = name.toLowerCase();
    for (const [id, memberName] of this.byId) {
      if (memberName.toLowerCase() === lower) return { member_id: id, name: memberName };
    }
    if (lower.length < 3) return undefined;
    const prefixMatches: [string, string][] = [];
    for (const entry of this.byId) {
      if (entry[1].toLowerCase().startsWith(lower)) prefixMatches.push(entry);
    }
    return prefixMatches.length === 1
      ? { member_id: prefixMatches[0]?.[0] ?? '', name: prefixMatches[0]?.[1] ?? '' }
      : undefined;
  }
}

/** Builds a working engine from a state, keyed by ref for O(1) lookup and mutation. */
class Working {
  cursor: number;
  readonly next: Mutable<Record<RefPrefix, number>>;
  readonly byRef = new Map<string, WorkingObject>();
  readonly order: string[] = [];
  readonly transitions: Transition[] = [];
  readonly roster = new Roster();
  /** Handoffs whose target's first subsequent message hasn't been evaluated yet, by ref. */
  readonly pendingFirstReply = new Set<string>();
  /** Messages already folded into a handoff-acceptance commitment, so per-sentence parsing doesn't duplicate it. */
  readonly consumedAsHandoffAccept = new Set<string>();

  constructor(state: CoordState) {
    this.cursor = state.cursor;
    this.next = { ...state.next };
    for (const object of state.objects) {
      const copy: WorkingObject = {
        ...object,
        targets: [...object.targets],
        related: [...object.related],
        sources: [...object.sources],
      };
      this.byRef.set(object.ref, copy);
      this.order.push(object.ref);
      this.roster.see(object.author);
      if (object.owner !== undefined) this.roster.see(object.owner);
      for (const target of object.targets) this.roster.see(target);
      if (object.kind === 'handoff' && object.status === 'pending')
        this.pendingFirstReply.add(object.ref);
    }
  }

  mint(kind: ObjectKind): string {
    const prefix = REF_PREFIX[kind];
    const n = this.next[prefix];
    this.next[prefix] = n + 1;
    return `${prefix}${String(n)}`;
  }

  create(
    kind: ObjectKind,
    fields: Omit<WorkingObject, 'ref' | 'kind' | 'targets' | 'related' | 'sources'> & {
      targets?: Member[];
      related?: string[];
    },
    source: { message_id: string; sequence: number },
    initialStatus: string,
    reason: string,
  ): WorkingObject {
    const ref = this.mint(kind);
    const object: WorkingObject = {
      ref,
      kind,
      targets: fields.targets ?? [],
      related: fields.related ?? [],
      sources: [source],
      ...fields,
    };
    this.byRef.set(ref, object);
    this.order.push(ref);
    // The roster only ever grows from members recorded on a created object (author/owner/targets), never
    // from "someone merely sent a message" - that isn't part of `CoordState`, so registering it any other
    // way wouldn't survive across `applyMessages` calls and would break one-by-one/one-call equivalence.
    this.roster.see(object.author);
    if (object.owner !== undefined) this.roster.see(object.owner);
    for (const target of object.targets) this.roster.see(target);
    this.transitions.push({
      ref,
      from: null,
      to: initialStatus,
      cause: 'message',
      message_id: source.message_id,
      reason,
    });
    return object;
  }

  transition(
    object: WorkingObject,
    to: string,
    seq: number,
    messageId: string | undefined,
    reason: string,
  ): void {
    if (object.status === to) return;
    const from = object.status;
    object.status = to;
    object.touched_seq = seq;
    this.transitions.push({
      ref: object.ref,
      from,
      to,
      cause: 'message',
      ...(messageId === undefined ? {} : { message_id: messageId }),
      reason,
    });
  }

  touch(object: WorkingObject, seq: number): void {
    object.touched_seq = seq;
  }

  toState(): CoordState {
    return {
      cursor: this.cursor,
      next: { ...this.next },
      objects: this.order.map((ref) => {
        const object = this.byRef.get(ref);
        if (object === undefined) throw new Error('unreachable: order/byRef out of sync');
        return {
          ...object,
          targets: [...object.targets],
          related: [...object.related],
          sources: [...object.sources],
        };
      }),
    };
  }
}

function refsOf(working: Working, kind: ObjectKind): WorkingObject[] {
  return working.order
    .map((ref) => working.byRef.get(ref))
    .filter((o): o is WorkingObject => o !== undefined && o.kind === kind);
}

function unsettled(object: WorkingObject): boolean {
  return UNSETTLED_STATUSES[object.kind].includes(object.status);
}

function terminal(object: WorkingObject): boolean {
  return !unsettled(object) && object.status !== 'detected';
}

/** Resolves a raw target name against the roster, dropping anything ambiguous or unknown. */
function resolveTargets(raw: readonly RawTarget[], working: Working): Member[] {
  const resolved: Member[] = [];
  for (const target of raw) {
    const member = working.roster.resolve(target.name);
    if (member !== undefined) resolved.push(member);
  }
  return resolved;
}

function refsMentioned(
  working: Working,
  event: ExtractedEvent,
  kind?: ObjectKind,
): WorkingObject[] {
  const found: WorkingObject[] = [];
  for (const ref of event.refs) {
    const object = working.byRef.get(ref);
    if (object !== undefined && (kind === undefined || object.kind === kind)) found.push(object);
  }
  return found;
}

function objectForMessage(
  working: Working,
  messageId: string,
  kind?: ObjectKind,
): WorkingObject | undefined {
  for (const ref of working.order) {
    const object = working.byRef.get(ref);
    if (object === undefined) continue;
    if (
      (kind === undefined || object.kind === kind) &&
      object.sources.some((s) => s.message_id === messageId)
    ) {
      return object;
    }
  }
  return undefined;
}

/** Repeated-question detection (§4): jaccard of content tokens against an ANSWERED question, >= 0.8. */
function findRepeatedQuestion(working: Working, text: string): WorkingObject | undefined {
  const tokens = contentTokens(text);
  for (const object of refsOf(working, 'question')) {
    if (object.status === 'answered' && jaccard(tokens, contentTokens(object.text)) >= SIMILAR)
      return object;
  }
  return undefined;
}

/** Resolves the dependency's blocker: an explicit ref, or the named member's latest open commitment. */
function findBlocker(
  working: Working,
  event: ExtractedEvent,
  targetName: string | undefined,
): WorkingObject | undefined {
  const byRef = refsMentioned(working, event).find((o) => o.kind !== 'dependency');
  if (byRef !== undefined) return byRef;
  if (targetName === undefined) return undefined;
  const member = working.roster.resolve(targetName);
  if (member === undefined) return undefined;
  const commitments = refsOf(working, 'commitment')
    .filter((o) => o.status === 'open' || o.status === 'in_progress')
    .filter((o) => (o.owner ?? o.author).member_id === member.member_id);
  return commitments.at(-1);
}

/** After an object reaches a terminal status, resolves every dependency that was waiting on it. */
function resolveDependenciesOn(
  working: Working,
  blockerRef: string,
  seq: number,
  messageId: string | undefined,
): void {
  for (const dependency of refsOf(working, 'dependency')) {
    if (dependency.status === 'waiting' && dependency.related.includes(blockerRef)) {
      working.transition(
        dependency,
        'resolved',
        seq,
        messageId,
        `blocker ${blockerRef} reached a terminal status`,
      );
    }
  }
}

const CONDITION_KEY = (conditions: readonly string[] | undefined): string =>
  [...(conditions ?? [])]
    .map((c) => [...contentTokens(c)].sort().join(' '))
    .sort()
    .join('|');

/** Detects conflicts between a claim and every other active, non-hedged claim by a different author. */
function detectConflicts(
  working: Working,
  claim: WorkingObject,
  seq: number,
  messageId: string,
): void {
  if (claim.hedged === true) return;
  for (const other of refsOf(working, 'claim')) {
    if (other.ref === claim.ref || other.status !== 'active' || other.hedged === true) continue;
    if (other.author.member_id === claim.author.member_id) continue;
    if (claim.polarity === other.polarity) continue;
    if (jaccard(contentTokens(claim.subject ?? ''), contentTokens(other.subject ?? '')) < SIMILAR)
      continue;
    if (jaccard(contentTokens(claim.predicate ?? ''), contentTokens(other.predicate ?? '')) < 0.5)
      continue;
    if (CONDITION_KEY(claim.conditions) !== CONDITION_KEY(other.conditions)) continue;
    const already = refsOf(working, 'conflict').some(
      (c) =>
        c.status === 'detected' && c.related.includes(claim.ref) && c.related.includes(other.ref),
    );
    if (already) continue;
    working.create(
      'conflict',
      {
        status: 'detected',
        text: claim.text,
        author: claim.author,
        related: [claim.ref, other.ref],
        created_seq: seq,
        touched_seq: seq,
      },
      { message_id: messageId, sequence: seq },
      'detected',
      `${claim.ref} conflicts with ${other.ref}`,
    );
  }
}

function resolveConflictsOn(working: Working, claimRef: string, seq: number): void {
  for (const conflict of refsOf(working, 'conflict')) {
    if (conflict.status === 'detected' && conflict.related.includes(claimRef)) {
      working.transition(conflict, 'resolved', seq, undefined, `${claimRef} left the conflict`);
    }
  }
}

/** One message's structural (reply-shaped) effects: these don't depend on any extracted event. */
function applyReplyStructure(
  working: Working,
  message: SourceMessage,
  events: readonly ExtractedEvent[],
): void {
  if (message.reply_to_message_id === null) return;
  const answered = objectForMessage(working, message.reply_to_message_id, 'question');
  if (
    answered !== undefined &&
    answered.author.member_id !== message.sender_member_id &&
    (answered.status === 'open' || answered.status === 'acknowledged')
  ) {
    working.transition(
      answered,
      'answered',
      message.sequence,
      message.message_id,
      'answered by reply',
    );
  }
  const acked = objectForMessage(working, message.reply_to_message_id, 'question');
  if (
    acked !== undefined &&
    acked.status === 'open' &&
    events.some((e) => e.type === 'acknowledgement')
  ) {
    if (acked.targets.some((t) => t.member_id === message.sender_member_id)) {
      working.transition(
        acked,
        'acknowledged',
        message.sequence,
        message.message_id,
        'acknowledged by reply',
      );
    }
  }
  const handoff = objectForMessage(working, message.reply_to_message_id, 'handoff');
  if (
    handoff !== undefined &&
    handoff.status === 'pending' &&
    handoff.targets[0]?.member_id === message.sender_member_id
  ) {
    working.pendingFirstReply.delete(handoff.ref);
    working.transition(
      handoff,
      'accepted',
      message.sequence,
      message.message_id,
      'accepted by reply',
    );
    createHandoffCommitment(working, handoff, message);
    working.consumedAsHandoffAccept.add(message.message_id);
  }
  const completing = objectForMessage(working, message.reply_to_message_id, 'commitment');
  if (
    completing !== undefined &&
    (completing.status === 'open' || completing.status === 'in_progress') &&
    events.some((e) => e.type === 'completion')
  ) {
    working.transition(
      completing,
      'completed',
      message.sequence,
      message.message_id,
      'completed by reply',
    );
    resolveDependenciesOn(working, completing.ref, message.sequence, message.message_id);
  }
}

function createHandoffCommitment(
  working: Working,
  handoff: WorkingObject,
  message: SourceMessage,
): void {
  const owner = handoff.targets[0] ?? {
    member_id: message.sender_member_id,
    name: message.sender_name,
  };
  working.create(
    'commitment',
    {
      status: 'open',
      text: handoff.text,
      author: owner,
      owner,
      related: [handoff.ref],
      created_seq: message.sequence,
      touched_seq: message.sequence,
    },
    { message_id: message.message_id, sequence: message.sequence },
    'open',
    `accepted handoff ${handoff.ref}`,
  );
}

/** The first message from `member` strictly after `sinceSeq`, considered once per pending handoff. */
function considerHandoffFirstReply(
  working: Working,
  message: SourceMessage,
  events: readonly ExtractedEvent[],
): void {
  for (const ref of [...working.pendingFirstReply]) {
    const handoff = working.byRef.get(ref);
    if (handoff === undefined || handoff.status !== 'pending') {
      working.pendingFirstReply.delete(ref);
      continue;
    }
    if (handoff.targets[0]?.member_id !== message.sender_member_id) continue;
    if (message.sequence <= handoff.created_seq) continue;
    working.pendingFirstReply.delete(ref);
    if (message.reply_to_message_id !== null) continue; // handled by applyReplyStructure, or not an implicit accept
    if (events.some((e) => e.type === 'acknowledgement')) {
      working.transition(
        handoff,
        'accepted',
        message.sequence,
        message.message_id,
        "target's next message acknowledges it",
      );
      createHandoffCommitment(working, handoff, message);
      working.consumedAsHandoffAccept.add(message.message_id);
    }
  }
}

function applyEvent(working: Working, event: ExtractedEvent): void {
  const { message } = event;
  const seq = message.sequence;
  const author: Member = { member_id: message.sender_member_id, name: message.sender_name };
  // Not registered in the roster here: registration only happens when `Working.create` actually records a
  // member on an object (see its comment), so a no-op event never makes its author resolvable by name.
  const source = { message_id: message.message_id, sequence: seq };

  switch (event.type) {
    case 'question': {
      const targets = resolveTargets(event.targets, working);
      const repeat = findRepeatedQuestion(working, event.text);
      working.create(
        'question',
        {
          text: event.text,
          author,
          targets,
          status: 'open',
          related: repeat === undefined ? [] : [repeat.ref],
          created_seq: seq,
          touched_seq: seq,
        },
        source,
        'open',
        'question opened',
      );
      break;
    }
    case 'handoff': {
      const targets = resolveTargets(event.targets, working);
      const takeOverRef = event.refs.find((ref) => working.byRef.get(ref)?.kind === 'commitment');
      if (takeOverRef !== undefined) {
        const old = working.byRef.get(takeOverRef);
        if (old !== undefined && (old.status === 'open' || old.status === 'in_progress')) {
          working.transition(old, 'withdrawn', seq, message.message_id, 'transferred');
          resolveDependenciesOn(working, old.ref, seq, message.message_id);
          working.create(
            'commitment',
            {
              text: event.text,
              author,
              owner: author,
              related: [old.ref],
              status: 'open',
              created_seq: seq,
              touched_seq: seq,
            },
            source,
            'open',
            `took over ${old.ref}`,
          );
        }
        break;
      }
      if (targets.length !== 1) {
        // "names exactly one member"; an unresolved or ambiguous target never becomes a handoff. A
        // request-shaped question degrades to a plain question rather than vanishing outright.
        if (event.text.endsWith('?')) {
          working.create(
            'question',
            {
              text: event.text,
              author,
              targets: [],
              status: 'open',
              related: [],
              created_seq: seq,
              touched_seq: seq,
            },
            source,
            'open',
            'question opened (unresolved target)',
          );
        }
        break;
      }
      working.create(
        'handoff',
        {
          text: event.text,
          author,
          targets,
          status: 'pending',
          related: [],
          created_seq: seq,
          touched_seq: seq,
        },
        source,
        'pending',
        'handoff requested',
      );
      working.pendingFirstReply.add(working.order.at(-1) ?? '');
      break;
    }
    case 'commitment': {
      // Already folded into a handoff-acceptance commitment (createHandoffCommitment); avoid a duplicate.
      if (working.consumedAsHandoffAccept.has(message.message_id)) break;
      const referenced = refsMentioned(working, event, 'question');
      for (const question of referenced) {
        if (question.status === 'open')
          working.transition(
            question,
            'acknowledged',
            seq,
            message.message_id,
            `referenced by ${event.type}`,
          );
      }
      working.create(
        'commitment',
        {
          text: event.text,
          author,
          owner: author,
          status: 'open',
          related: [],
          created_seq: seq,
          touched_seq: seq,
          ...(event.optional === true ? { optional: true } : {}),
          ...(event.conditions !== undefined ? { conditions: event.conditions } : {}),
        },
        source,
        'open',
        'commitment made',
      );
      break;
    }
    case 'status_update': {
      const mine = refsOf(working, 'commitment').filter(
        (c) =>
          (c.owner ?? c.author).member_id === author.member_id &&
          (c.status === 'open' || c.status === 'in_progress'),
      );
      const target = refsMentioned(working, event, 'commitment')[0] ?? mine.at(-1);
      if (target !== undefined && target.status === 'open') {
        working.transition(target, 'in_progress', seq, message.message_id, 'status update');
      } else if (target !== undefined) {
        working.touch(target, seq);
      }
      break;
    }
    case 'completion': {
      const referenced = refsMentioned(working, event, 'commitment')[0];
      const mine = refsOf(working, 'commitment').filter(
        (c) =>
          (c.owner ?? c.author).member_id === author.member_id &&
          (c.status === 'open' || c.status === 'in_progress'),
      );
      const target = referenced ?? (mine.length === 1 ? mine[0] : undefined);
      if (target !== undefined) {
        working.transition(target, 'completed', seq, message.message_id, 'completion');
        resolveDependenciesOn(working, target.ref, seq, message.message_id);
        const handoff = refsOf(working, 'handoff').find(
          (h) => h.status === 'accepted' && h.related.includes(target.ref),
        );
        if (handoff !== undefined)
          working.transition(
            handoff,
            'completed',
            seq,
            message.message_id,
            `${target.ref} completed`,
          );
      }
      break;
    }
    case 'withdrawal': {
      const referenced = refsMentioned(working, event)[0];
      const mineOpenQuestion = refsOf(working, 'question').find(
        (q) =>
          q.author.member_id === author.member_id &&
          (q.status === 'open' || q.status === 'acknowledged'),
      );
      const mineOpenCommitment = refsOf(working, 'commitment').find(
        (c) =>
          (c.owner ?? c.author).member_id === author.member_id &&
          (c.status === 'open' || c.status === 'in_progress'),
      );
      const target = referenced ?? mineOpenCommitment ?? mineOpenQuestion;
      if (
        target !== undefined &&
        (target.kind !== 'question' || target.author.member_id === author.member_id)
      ) {
        if (target.kind === 'claim' && target.status === 'active') {
          working.transition(target, 'retracted', seq, message.message_id, 'withdrawn');
          resolveConflictsOn(working, target.ref, seq);
        } else if (target.status !== 'completed' && target.status !== 'answered') {
          working.transition(target, 'withdrawn', seq, message.message_id, 'withdrawn');
          resolveDependenciesOn(working, target.ref, seq, message.message_id);
        }
      }
      break;
    }
    case 'decline': {
      const handoff = refsOf(working, 'handoff').find(
        (h) => h.status === 'pending' && h.targets.some((t) => t.member_id === author.member_id),
      );
      if (handoff !== undefined) {
        working.pendingFirstReply.delete(handoff.ref);
        working.transition(handoff, 'declined', seq, message.message_id, 'declined');
      }
      break;
    }
    case 'decision': {
      const superseded =
        event.subject === undefined
          ? undefined
          : refsOf(working, 'decision').find(
              (d) =>
                d.status === 'active' &&
                jaccard(contentTokens(d.subject ?? ''), contentTokens(event.subject ?? '')) >=
                  SIMILAR,
            );
      const created = working.create(
        'decision',
        {
          text: event.text,
          author,
          status: 'active',
          related: superseded === undefined ? [] : [superseded.ref],
          created_seq: seq,
          touched_seq: seq,
          ...(event.subject !== undefined ? { subject: event.subject } : {}),
          ...(event.value !== undefined ? { value: event.value } : {}),
        },
        source,
        'active',
        'decision recorded',
      );
      if (superseded !== undefined) {
        working.transition(
          superseded,
          'superseded',
          seq,
          message.message_id,
          `superseded by ${created.ref}`,
        );
        superseded.related = [...superseded.related, created.ref];
      }
      if (event.subject !== undefined) {
        for (const conflict of refsOf(working, 'conflict')) {
          if (conflict.status !== 'detected') continue;
          const claims = conflict.related
            .map((ref) => working.byRef.get(ref))
            .filter((o): o is WorkingObject => o !== undefined);
          if (
            claims.some(
              (c) =>
                jaccard(contentTokens(c.subject ?? ''), contentTokens(event.subject ?? '')) >=
                SIMILAR,
            )
          ) {
            working.transition(
              conflict,
              'resolved',
              seq,
              message.message_id,
              `settled by decision ${created.ref}`,
            );
          }
        }
      }
      break;
    }
    case 'claim': {
      const superseding =
        event.subject === undefined
          ? undefined
          : refsOf(working, 'claim').find(
              (c) =>
                c.status === 'active' &&
                c.author.member_id === author.member_id &&
                jaccard(contentTokens(c.subject ?? ''), contentTokens(event.subject ?? '')) >=
                  SIMILAR,
            );
      const created = working.create(
        'claim',
        {
          text: event.text,
          author,
          status: 'active',
          related: superseding === undefined ? [] : [superseding.ref],
          created_seq: seq,
          touched_seq: seq,
          ...(event.subject !== undefined ? { subject: event.subject } : {}),
          ...(event.predicate !== undefined ? { predicate: event.predicate } : {}),
          ...(event.polarity !== undefined ? { polarity: event.polarity } : {}),
          ...(event.conditions !== undefined ? { conditions: event.conditions } : {}),
          ...(event.hedged === true ? { hedged: true } : {}),
        },
        source,
        'active',
        'claim recorded',
      );
      if (superseding !== undefined) {
        working.transition(
          superseding,
          'superseded',
          seq,
          message.message_id,
          `superseded by ${created.ref}`,
        );
        resolveConflictsOn(working, superseding.ref, seq);
      }
      detectConflicts(working, created, seq, message.message_id);
      break;
    }
    case 'dependency': {
      const targetName = event.targets[0]?.name;
      const blocker = findBlocker(working, event, targetName);
      if (blocker === undefined) break; // "if no blocker is found, no dependency is created"
      const status = terminal(blocker) ? 'resolved' : 'waiting';
      working.create(
        'dependency',
        {
          text: event.text,
          author,
          status,
          related: [blocker.ref],
          created_seq: seq,
          touched_seq: seq,
        },
        source,
        status,
        status === 'resolved'
          ? `blocker ${blocker.ref} already terminal`
          : `waiting on ${blocker.ref}`,
      );
      break;
    }
    case 'acknowledgement': {
      const targeted = refsOf(working, 'question').find(
        (q) =>
          q.status === 'open' &&
          q.targets.some((t) => t.member_id === author.member_id) &&
          q.sources.some((s) => s.message_id !== message.message_id),
      );
      if (targeted !== undefined && message.reply_to_message_id === null) {
        working.transition(targeted, 'acknowledged', seq, message.message_id, 'acknowledged');
      }
      break;
    }
    case 'answer': {
      const explicit = refsMentioned(working, event, 'question')[0];
      if (
        explicit !== undefined &&
        (explicit.status === 'open' || explicit.status === 'acknowledged')
      ) {
        working.transition(explicit, 'answered', seq, message.message_id, 'answered');
      }
      break;
    }
  }
}

export const applyMessages: ApplyMessages = (state, messages, ctx: ApplyContext): ApplyResult => {
  const working = new Working(state);
  const excluded = new Set(ctx.excludeMemberIds);
  const ordered = [...messages]
    .filter(
      (m) =>
        m.sequence > working.cursor &&
        !excluded.has(m.sender_member_id) &&
        !m.content.startsWith('chorus-verify '),
    )
    .sort((a, b) => a.sequence - b.sequence);

  for (const message of ordered) {
    // The roster is derived only from `state.objects` (authors/owners/targets of objects created so far),
    // never from "this member merely sent a message" - that bookkeeping isn't part of `CoordState`, so it
    // wouldn't survive across `applyMessages` calls and would break one-by-one/one-call equivalence.
    const events = extractEvents(message);
    considerHandoffFirstReply(working, message, events);
    applyReplyStructure(working, message, events);
    for (const event of events) applyEvent(working, event);
    working.cursor = message.sequence;
  }

  return { state: working.toState(), transitions: working.transitions };
};

export const evaluateTextSimilarity = textSimilarity; // re-exported for rules.ts convenience
export const EMPTY = EMPTY_STATE;
