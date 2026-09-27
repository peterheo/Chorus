/**
 * CC-2a coordination engine (spec §4): folds the events of each new room message into a session's inferred
 * conversation state. Pure (spec D6): no I/O, no clock, no randomness, no mutation of its input. Everything it
 * decides depends only on the state and the message, so applying messages one at a time gives exactly the same
 * state and transitions as applying them in one call.
 *
 * Message text is DATA. The injected extractor only matches it against fixed patterns, and the engine only
 * follows the resulting events; nothing a message says can make Chorus act (spec D1: every object is inferred).
 */
import type { SourceMessage } from '../conversation/extract.ts';
import type { CoordEvent, CoordEventType, ExtractEvents } from './events.ts';
import { contentTokens, jaccard } from './similarity.ts';
import {
  OBJECT_STATUSES,
  REF_PREFIX,
  UNSETTLED_STATUSES,
  type ApplyMessages,
  type ApplyResult,
  type CoordObject,
  type CoordState,
  type Member,
  type ObjectKind,
  type Transition,
} from './types.ts';

/** What the engine needs to know about the message whose events it applies. */
export type MessageFacts = {
  readonly message_id: string;
  readonly sequence: number;
  readonly sender: Member;
  readonly reply_to_message_id: string | null;
};

type Fields = Omit<
  CoordObject,
  'ref' | 'kind' | 'status' | 'sources' | 'created_seq' | 'touched_seq'
>;

/** Same subject / same question / same decision (spec §4). */
const SAME_SUBJECT = 0.8;
/** Predicates close enough to disagree about the same thing (conflicts). */
const SAME_PREDICATE = 0.5;

/**
 * A reply to a question from someone other than its author answers it, whatever event the extractor chose for
 * its sentences, UNLESS the message carries one of these events, which keep their own meaning: a counter-question,
 * a handoff, a commitment or acknowledgement (they acknowledge instead), a decline, a withdrawal, a status update
 * or a dependency. The extractor's per-sentence precedence cannot see state, so this rule is per message.
 */
const NOT_AN_ANSWER: ReadonlySet<CoordEventType> = new Set([
  'question',
  'handoff',
  'commitment',
  'acknowledgement',
  'decline',
  'withdrawal',
  'status_update',
  'dependency',
]);

/** Intermediate statuses: neither the initial one nor terminal. `dismissed` is terminal for every kind. */
const INTERMEDIATE: ReadonlySet<string> = new Set(['acknowledged', 'in_progress', 'accepted']);

export const isTerminal = (object: CoordObject): boolean =>
  object.status !== OBJECT_STATUSES[object.kind][0] && !INTERMEDIATE.has(object.status);

const isUnsettled = (object: CoordObject): boolean =>
  UNSETTLED_STATUSES[object.kind].includes(object.status);

const same = (a: Member | undefined, b: Member): boolean => a?.member_id === b.member_id;

const refNumber = (ref: string): number => Number(ref.slice(1));
const subjectOf = (object: CoordObject): readonly string[] => contentTokens(object.subject ?? '');

/** Code-unit string order (never locale-dependent). */
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The deterministic object order: by `created_seq`, then ref (prefix, then number). */
export const byObjectOrder = (a: CoordObject, b: CoordObject): number =>
  a.created_seq - b.created_seq ||
  compare(a.ref.slice(0, 1), b.ref.slice(0, 1)) ||
  refNumber(a.ref) - refNumber(b.ref);

/** Who a dependency on this object waits for. */
const holderOf = (blocker: CoordObject): Member =>
  blocker.kind === 'dependency'
    ? blocker.author
    : (blocker.owner ?? blocker.targets[0] ?? blocker.author);

/** Copies only the defined fields, so objects stay JSON-exact under `exactOptionalPropertyTypes`. */
function compact<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * The roster handed to the extractor: every member named on an object (author, owner, targets) plus the
 * sender, by member id, with the most recent name (the sender's own name wins). It is derived from the state
 * and the current message ONLY. Senders of earlier messages in the same call are deliberately NOT added: a
 * member who has only sent messages that created no object is not in the persisted state, so adding them
 * would make a batch resolve names that a message-by-message run cannot (see the roster test).
 */
export function rosterOf(state: CoordState, sender: Member): readonly Member[] {
  const names = new Map<string, string>();
  for (const object of [...state.objects].sort(byObjectOrder)) {
    for (const member of [object.author, object.owner, ...object.targets]) {
      if (member !== undefined) names.set(member.member_id, member.name);
    }
  }
  names.set(sender.member_id, sender.name);
  return [...names.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([member_id, name]) => ({ member_id, name }));
}

/**
 * Applies one message's events to the state (the engine core; the cursor moves to the message). Exported for
 * tests that drive the rules with hand-built events.
 */
export function applyEvents(
  state: CoordState,
  message: MessageFacts,
  events: readonly CoordEvent[],
): ApplyResult {
  const objects = new Map(state.objects.map((object) => [object.ref, object]));
  const next = { ...state.next };
  const transitions: Transition[] = [];
  const sender = message.sender;
  const source = { message_id: message.message_id, sequence: message.sequence };

  const list = (): CoordObject[] => [...objects.values()].sort(byObjectOrder);
  const get = (ref: string): CoordObject | undefined => objects.get(ref);
  const at = (ref: string): CoordObject => {
    const object = objects.get(ref);
    if (object === undefined) throw new Error(`unknown ref ${ref}`);
    return object;
  };

  /** Records that this message touched an object (and changes some of its fields). */
  const touch = (ref: string, patch: Partial<CoordObject> = {}): void => {
    const object = at(ref);
    const sources =
      object.sources.at(-1)?.message_id === source.message_id
        ? object.sources
        : [...object.sources, source];
    objects.set(ref, { ...object, ...patch, sources, touched_seq: message.sequence });
  };
  const relate = (ref: string, other: string): void => {
    const related = at(ref).related;
    if (!related.includes(other)) touch(ref, { related: [...related, other] });
  };

  const record = (ref: string, from: string | null, to: string, reason: string): void => {
    transitions.push({ ref, from, to, cause: 'message', message_id: message.message_id, reason });
  };

  const create = (kind: ObjectKind, fields: Fields, reason: string): CoordObject => {
    const prefix = REF_PREFIX[kind];
    const ref = `${prefix}${String(next[prefix])}`;
    next[prefix] += 1;
    const status = OBJECT_STATUSES[kind][0] ?? 'open';
    const seq = message.sequence;
    const object = {
      ref,
      kind,
      status,
      ...fields,
      sources: [source],
      created_seq: seq,
      touched_seq: seq,
    };
    objects.set(ref, object);
    record(ref, null, status, reason);
    return object;
  };

  const setStatus = (ref: string, to: string, reason: string): void => {
    const from = at(ref).status;
    if (from === to) return;
    record(ref, from, to, reason);
    touch(ref, { status: to });
    cascade(at(ref));
  };

  /** What follows a status change: handoff completion, conflict resolution, unblocked dependencies. */
  const cascade = (changed: CoordObject): void => {
    for (const object of list()) {
      const follows =
        (object.kind === 'handoff' &&
          object.status === 'accepted' &&
          changed.kind === 'commitment' &&
          changed.status === 'completed' &&
          changed.related.includes(object.ref)) ||
        (object.kind === 'conflict' &&
          object.status === 'detected' &&
          changed.kind === 'claim' &&
          changed.status !== 'active' &&
          object.related.includes(changed.ref)) ||
        (object.kind === 'dependency' &&
          object.status === 'waiting' &&
          isTerminal(changed) &&
          object.related[0] === changed.ref);
      if (follows)
        setStatus(
          object.ref,
          object.kind === 'handoff' ? 'completed' : 'resolved',
          `${changed.ref} ${changed.status}`,
        );
    }
  };
  const targetsSender = (object: CoordObject): boolean =>
    object.targets.some((target) => same(target, sender));
  const pendingToSender = (object: CoordObject): boolean =>
    object.kind === 'handoff' && object.status === 'pending' && targetsSender(object);

  /** Objects an event names: by `\b[QCHDKXP]\d+\b` ref, or by replying to the message that created them. */
  const named = (event: CoordEvent): CoordObject[] =>
    list().filter(
      (object) =>
        event.refs.includes(object.ref) ||
        (event.reply_to_message_id !== null &&
          object.sources[0]?.message_id === event.reply_to_message_id),
    );

  /**
   * The sender's unsettled commitments an event is about: those it names (directly, or through a named accepted
   * handoff), else the sender's ONLY unsettled commitment, else none.
   */
  const commitmentsOf = (event: CoordEvent): CoordObject[] => {
    const mine = (object: CoordObject): boolean =>
      object.kind === 'commitment' && same(object.owner, sender) && isUnsettled(object);
    const refs = named(event).flatMap((object) =>
      object.kind === 'handoff' ? object.related : [object.ref],
    );
    const direct = list().filter((object) => mine(object) && refs.includes(object.ref));
    if (direct.length > 0) return direct;
    const all = list().filter(mine);
    return all.length === 1 ? all : [];
  };

  /**
   * Pending handoffs to the sender that an event accepts or declines: those it names, else, when the event
   * replies to nothing, those for which this is the target's first message since the handoff (a pending
   * handoff's later sources are exactly its targets' messages, see the end of this function).
   */
  const pendingFor = (event: CoordEvent): CoordObject[] => {
    const direct = named(event).filter(pendingToSender);
    if (direct.length > 0 || event.reply_to_message_id !== null) return direct;
    return list().filter((object) => pendingToSender(object) && object.sources.length === 1);
  };

  const accept = (handoff: CoordObject): void => {
    setStatus(handoff.ref, 'accepted', 'accepted by target');
    const commitment = create(
      'commitment',
      { text: handoff.text, author: sender, owner: sender, targets: [], related: [handoff.ref] },
      `accepted ${handoff.ref}`,
    );
    touch(handoff.ref, { owner: sender });
    relate(handoff.ref, commitment.ref);
  };

  /** The object fields an event carries (the extractor sets only those of its type). */
  const fieldsOf = (event: CoordEvent, related: readonly string[] = []): Fields => ({
    text: event.text,
    author: sender,
    targets: event.targets,
    related,
    ...compact({
      subject: event.subject,
      predicate: event.predicate,
      polarity: event.polarity,
      hedged: event.hedged,
      conditions: event.conditions,
      value: event.value,
      optional: event.optional,
    }),
  });

  /** `newer` supersedes the active `kind` objects on the same subject that `also` accepts, related both ways. */
  const supersede = (newer: CoordObject, also: (older: CoordObject) => boolean): void => {
    for (const older of list()) {
      if (
        older.kind === newer.kind &&
        older.ref !== newer.ref &&
        older.status === 'active' &&
        also(older) &&
        jaccard(subjectOf(older), subjectOf(newer)) >= SAME_SUBJECT
      ) {
        setStatus(older.ref, 'superseded', `superseded by ${newer.ref}`);
        relate(older.ref, newer.ref);
        relate(newer.ref, older.ref);
      }
    }
  };

  const onEvent = (event: CoordEvent): void => {
    switch (event.type) {
      case 'question': {
        const tokens = contentTokens(event.text);
        const repeated = list()
          .filter(
            (object) =>
              object.kind === 'question' &&
              object.status === 'answered' &&
              jaccard(contentTokens(object.text), tokens) >= SAME_SUBJECT,
          )
          .map((object) => object.ref);
        const reason = repeated.length > 0 ? `repeats ${repeated.join(', ')}` : 'asked';
        create('question', fieldsOf(event, repeated), reason);
        return;
      }
      case 'handoff': {
        const taken = event.take_over === undefined ? undefined : get(event.take_over);
        const transferred = taken?.kind === 'commitment' ? taken : undefined;
        create(
          'handoff',
          {
            text: event.text,
            author: sender,
            targets: event.targets.filter((target) => !same(target, sender)),
            related: transferred === undefined ? [] : [transferred.ref],
          },
          'handed off',
        );
        if (
          transferred !== undefined &&
          same(transferred.owner, sender) &&
          isUnsettled(transferred)
        )
          setStatus(transferred.ref, 'withdrawn', 'transferred');
        return;
      }
      case 'answer': {
        const question = event.answers === undefined ? undefined : get(event.answers);
        if (
          question?.kind === 'question' &&
          isUnsettled(question) &&
          !same(question.author, sender)
        )
          setStatus(question.ref, 'answered', 'answered');
        return;
      }
      case 'withdrawal': {
        const withdrawable = (object: CoordObject): boolean =>
          (object.kind === 'commitment' && same(object.owner, sender) && isUnsettled(object)) ||
          (object.kind === 'claim' && same(object.author, sender) && object.status === 'active');
        let targets = named(event).filter(
          (object) =>
            withdrawable(object) ||
            (object.kind === 'question' && same(object.author, sender) && isUnsettled(object)),
        );
        if (targets.length === 0) {
          // Unnamed ("scratch that"): the sender's most recently created commitments and claims.
          const candidates = list().filter(withdrawable);
          const latest = Math.max(...candidates.map((object) => object.created_seq));
          targets = candidates.filter((object) => object.created_seq === latest);
        }
        for (const object of targets) {
          setStatus(object.ref, object.kind === 'claim' ? 'retracted' : 'withdrawn', 'withdrawn');
        }
        return;
      }
      case 'decline':
        for (const handoff of pendingFor(event)) setStatus(handoff.ref, 'declined', 'declined');
        return;
      case 'acknowledgement': {
        for (const handoff of pendingFor(event)) accept(handoff);
        for (const question of named(event)) {
          if (question.kind === 'question' && question.status === 'open' && targetsSender(question))
            setStatus(question.ref, 'acknowledged', 'acknowledged by target');
        }
        return;
      }
      case 'commitment': {
        const handoffs = named(event).filter(pendingToSender);
        for (const handoff of handoffs) accept(handoff);
        const questions = named(event).filter((object) => object.kind === 'question');
        if (handoffs.length === 0) {
          const related = questions.map((question) => question.ref);
          create('commitment', { ...fieldsOf(event, related), owner: sender }, 'committed');
        }
        for (const question of questions) {
          if (question.status === 'open')
            setStatus(question.ref, 'acknowledged', 'commitment made');
        }
        return;
      }
      case 'completion':
        for (const commitment of commitmentsOf(event))
          setStatus(commitment.ref, 'completed', 'completed by owner');
        return;
      case 'status_update':
        for (const commitment of commitmentsOf(event)) {
          if (commitment.status === 'open')
            setStatus(commitment.ref, 'in_progress', 'status update');
          else touch(commitment.ref);
        }
        return;
      case 'dependency': {
        const blocker = event.blocker ?? {};
        let found: CoordObject | undefined;
        if (blocker.ref !== undefined) found = get(blocker.ref);
        else if (blocker.member !== undefined) {
          const member = blocker.member;
          found = list()
            .filter(
              (object) =>
                object.kind === 'commitment' && same(object.owner, member) && isUnsettled(object),
            )
            .at(-1);
        }
        if (found === undefined) return; // no blocker, no dependency
        const dependency = create(
          'dependency',
          { text: event.text, author: sender, targets: [holderOf(found)], related: [found.ref] },
          `waits on ${found.ref}`,
        );
        if (isTerminal(found))
          setStatus(dependency.ref, 'resolved', `${found.ref} ${found.status}`);
        return;
      }
      case 'decision': {
        const decision = create('decision', fieldsOf(event), 'decided');
        if (subjectOf(decision).length === 0) return;
        supersede(decision, () => true);
        for (const conflict of list()) {
          if (
            conflict.kind === 'conflict' &&
            conflict.status === 'detected' &&
            jaccard(subjectOf(conflict), subjectOf(decision)) >= SAME_SUBJECT
          )
            setStatus(conflict.ref, 'resolved', `decided by ${decision.ref}`);
        }
        return;
      }
      case 'claim': {
        const claim = create('claim', fieldsOf(event), 'claimed');
        if (subjectOf(claim).length === 0) return;
        supersede(claim, (older) => same(older.author, sender));
        for (const other of list()) {
          if (
            other.kind === 'claim' &&
            other.ref !== claim.ref &&
            conflicting(other, at(claim.ref))
          )
            create(
              'conflict',
              {
                text: claim.text,
                author: sender,
                targets: [other.author],
                related: [other.ref, claim.ref],
                ...compact({ subject: other.subject }),
              },
              `${other.ref} vs ${claim.ref}`,
            );
        }
        return;
      }
    }
  };

  // A reply to a question's message from anyone but its author answers it (see NOT_AN_ANSWER).
  if (
    message.reply_to_message_id !== null &&
    !events.some((event) => NOT_AN_ANSWER.has(event.type))
  ) {
    for (const question of list()) {
      if (
        question.kind === 'question' &&
        isUnsettled(question) &&
        question.sources[0]?.message_id === message.reply_to_message_id &&
        !same(question.author, sender)
      )
        setStatus(question.ref, 'answered', 'reply');
    }
  }

  for (const event of events) onEvent(event);

  // Every later message from a pending handoff's target is recorded on it: the "next message" acceptance rule
  // and the `missing_acknowledgement` count both read these sources.
  for (const handoff of list()) {
    if (pendingToSender(handoff) && handoff.created_seq < message.sequence) touch(handoff.ref);
  }

  return {
    state: { cursor: message.sequence, next, objects: list() },
    transitions,
  };
}

/**
 * Two claims disagree (spec §4): both active and unhedged, different authors, subject Jaccard ≥ 0.8, predicate
 * Jaccard ≥ 0.5, opposite polarity, and overlapping conditions (both empty, or equal after normalization).
 */
export function conflicting(a: CoordObject, b: CoordObject): boolean {
  const conditions = (claim: CoordObject): string =>
    JSON.stringify(
      [...new Set((claim.conditions ?? []).map((c) => contentTokens(c).join(' ')))].sort(),
    );
  return (
    a.status === 'active' &&
    b.status === 'active' &&
    a.hedged !== true &&
    b.hedged !== true &&
    a.author.member_id !== b.author.member_id &&
    jaccard(subjectOf(a), subjectOf(b)) >= SAME_SUBJECT &&
    jaccard(contentTokens(a.predicate ?? ''), contentTokens(b.predicate ?? '')) >= SAME_PREDICATE &&
    (a.polarity ?? 'pos') !== (b.polarity ?? 'pos') &&
    conditions(a) === conditions(b)
  );
}

/**
 * The engine over an extractor (spec §4): messages in ascending sequence, only those after the cursor; excluded
 * seats and `chorus-verify ` proofs move the cursor but are otherwise ignored.
 */
export function createEngine(extract: ExtractEvents): ApplyMessages {
  return (state, messages, ctx) => {
    const excluded = new Set(ctx.excludeMemberIds);
    const transitions: Transition[] = [];
    let current: CoordState = { ...state, objects: [...state.objects].sort(byObjectOrder) };
    const ordered = [...messages].sort((a, b) => a.sequence - b.sequence);
    for (const message of ordered) {
      if (message.sequence <= current.cursor) continue;
      if (skipped(message, excluded)) {
        current = { ...current, cursor: message.sequence };
        continue;
      }
      const sender = { member_id: message.sender_member_id, name: message.sender_name };
      const { message_id, sequence, reply_to_message_id } = message;
      const facts = { message_id, sequence, sender, reply_to_message_id };
      const result = applyEvents(current, facts, extract(message, rosterOf(current, sender)));
      current = result.state;
      transitions.push(...result.transitions);
    }
    return { state: current, transitions };
  };
}

const skipped = (message: SourceMessage, excluded: ReadonlySet<string>): boolean =>
  excluded.has(message.sender_member_id) || message.content.startsWith('chorus-verify ');
