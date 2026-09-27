/**
 * CC-2 coordination engine: the frozen contract between the pure engine (CC-2a: extract, engine, rules) and its
 * persistence and tools (CC-2c). Every object here is INFERRED from room messages. It is evidence, never
 * canonical work, and it changes tasks only through an explicit link (spec D1).
 */
import type { SourceMessage } from '../conversation/extract.ts';

export type ObjectKind =
  'question' | 'commitment' | 'handoff' | 'decision' | 'claim' | 'conflict' | 'dependency';

/** Short-ref prefix per kind, in the same order as `ObjectKind`: Q1, C2, H3, D4, K5, X6, P7. */
export type RefPrefix = 'Q' | 'C' | 'H' | 'D' | 'K' | 'X' | 'P';

export const REF_PREFIX: Readonly<Record<ObjectKind, RefPrefix>> = {
  question: 'Q',
  commitment: 'C',
  handoff: 'H',
  decision: 'D',
  claim: 'K',
  conflict: 'X',
  dependency: 'P',
};

/** Every status each kind can be in (spec §4). The first entry is the initial status. */
export const OBJECT_STATUSES: Readonly<Record<ObjectKind, readonly string[]>> = {
  question: ['open', 'acknowledged', 'answered', 'withdrawn', 'dismissed'],
  commitment: ['open', 'in_progress', 'completed', 'withdrawn', 'dismissed'],
  handoff: ['pending', 'accepted', 'declined', 'completed', 'dismissed'],
  decision: ['active', 'superseded', 'dismissed'],
  claim: ['active', 'retracted', 'superseded', 'dismissed'],
  conflict: ['detected', 'resolved', 'dismissed'],
  dependency: ['waiting', 'resolved', 'dismissed'],
};

/**
 * Statuses that still need something from someone: they block `ready_to_close` (spec §5). Active decisions and
 * active claims are settled facts, not open work, so they never block it.
 */
export const UNSETTLED_STATUSES: Readonly<Record<ObjectKind, readonly string[]>> = {
  question: ['open', 'acknowledged'],
  commitment: ['open', 'in_progress'],
  handoff: ['pending'],
  decision: [],
  claim: [],
  conflict: ['detected'],
  dependency: ['waiting'],
};

/** The status `chorus.update_conversation_object` action `resolve` moves an object to (spec §9). */
export const RESOLVED_STATUS: Readonly<Partial<Record<ObjectKind, string>>> = {
  question: 'answered',
  commitment: 'completed',
  handoff: 'completed',
  conflict: 'resolved',
  dependency: 'resolved',
};

export interface Member {
  readonly member_id: string;
  readonly name: string;
}

export interface MessageSource {
  readonly message_id: string;
  readonly sequence: number;
}

export interface CoordObject {
  /** Per-session short ref: Q1, C2, … Numbering is per prefix, and a ref is never reused. */
  readonly ref: string;
  readonly kind: ObjectKind;
  /** One of `OBJECT_STATUSES[kind]`. */
  readonly status: string;
  /** The source sentence, at most 280 code points (the CC-1a truncation rule). */
  readonly text: string;
  readonly author: Member;
  /** A commitment's or accepted handoff's owner. */
  readonly owner?: Member;
  /** Addressed members (handoffs, targeted questions). */
  readonly targets: readonly Member[];
  readonly subject?: string;
  readonly predicate?: string;
  readonly polarity?: 'pos' | 'neg';
  readonly conditions?: readonly string[];
  readonly hedged?: boolean;
  /** Decisions of the form "X is Y". */
  readonly value?: string;
  /** Conditional commitment ("I can … if …"). */
  readonly optional?: boolean;
  /** Refs this object points at (answer→question, dependency→blocker, conflict→claims, …). */
  readonly related: readonly string[];
  /** Provenance, ascending by sequence. */
  readonly sources: readonly MessageSource[];
  readonly created_seq: number;
  readonly touched_seq: number;
  /** Set only through an explicit CC-1 link (spec D9). */
  readonly linked_item_id?: string;
}

export interface CoordState {
  /** The highest message sequence the engine has applied for this session (spec D7). */
  readonly cursor: number;
  /** The next number per prefix. */
  readonly next: Readonly<Record<RefPrefix, number>>;
  readonly objects: readonly CoordObject[];
}

export interface Transition {
  readonly ref: string;
  /** `null` when the object is created. */
  readonly from: string | null;
  readonly to: string;
  readonly cause: 'message' | 'command';
  readonly message_id?: string;
  readonly reason: string;
}

export type SignalKind =
  | 'conflict'
  | 'decision_contradicted'
  | 'duplicate_commitments'
  | 'dependency_resolved'
  | 'dependency_deadlock'
  | 'unanswered_question'
  | 'missing_acknowledgement'
  | 'stale_commitment'
  | 'ready_to_close';

export interface Signal {
  readonly kind: SignalKind;
  readonly refs: readonly string[];
  readonly members: readonly Member[];
  readonly reason: string;
  readonly suggested_next_action: string;
}

export interface ApplyContext {
  /** Members whose messages are never applied (the room's Chorus service seat). */
  readonly excludeMemberIds: readonly string[];
}

export interface ApplyResult {
  readonly state: CoordState;
  readonly transitions: readonly Transition[];
}

/** The engine's signature (implemented in CC-2a's `engine.ts`). It is pure: no mutation of its input, no clock. */
export type ApplyMessages = (
  state: CoordState,
  messages: readonly SourceMessage[],
  ctx: ApplyContext,
) => ApplyResult;

/** The signal evaluator's signature (implemented in CC-2a's `rules.ts`). It is pure. */
export type Evaluate = (state: CoordState) => readonly Signal[];

/** The empty state of a session that has never been scanned. */
export const EMPTY_STATE: CoordState = {
  cursor: 0,
  next: { Q: 1, C: 1, H: 1, D: 1, K: 1, X: 1, P: 1 },
  objects: [],
};
