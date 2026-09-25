// Layer 2 (spec §9–§10): domain objects with resolved IDs, held in memory.
// Short IDs (Q17, C4, K9, X3) are per-room and shown everywhere a human looks.

export interface Agent {
  id: string; // external ID (SharedNet i_… or fixture name)
  displayName: string;
  aliases: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  lastRoomIndex: number;
}

export interface Message {
  id: string; // external message ID
  seq: number; // transport sequence, shown as #N
  roomIndex: number; // count of non-Chorus messages up to and including this one; 0 for Chorus
  authorId: string;
  text: string;
  timestamp: string;
  replyToId?: string;
  isFromChorus: boolean;
}

interface Provenance {
  id: string; // short ID
  createdAt: string;
  createdIndex: number; // room index when created
  derivedFromMessageIds: string[];
  extractorConfidence: number;
}

export type QuestionStatus = "open" | "acknowledged" | "answered" | "superseded" | "withdrawn";

export interface Question extends Provenance {
  kind: "question" | "request";
  sourceMessageId: string;
  askerId: string;
  targetIds: string[];
  text: string;
  status: QuestionStatus;
  answerMessageIds: string[];
  claimedByCommitmentId?: string;
  /** an earlier answered question this one repeats (§23) */
  duplicateOf?: string;
  ackIndex?: number;
  lastSurfacedIndex?: number;
  ignored?: boolean;
  resolvedAt?: string;
}

export type CommitmentStatus =
  | "proposed"
  | "accepted"
  | "in_progress"
  | "completed"
  | "blocked"
  | "cancelled"
  | "expired";

export interface Commitment extends Provenance {
  ownerId: string;
  sourceMessageId: string;
  action: string;
  status: CommitmentStatus;
  optional: boolean;
  deadline?: string;
  completionMessageId?: string;
  /** set when created by accepting a handoff (§16.3) */
  fromHandoffId?: string;
  /** room index of the last message that touched this commitment (§21) */
  updatedIndex: number;
  updatedAt: string;
  lastSurfacedIndex?: number;
  ignored?: boolean;
}

export type HandoffStatus = "pending" | "accepted" | "declined" | "completed" | "cancelled" | "expired";

/** Targeted requests and explicit transfers of work (§10.3). */
export interface Handoff extends Provenance {
  fromAgentId: string;
  toAgentId: string;
  action: string;
  sourceMessageId: string;
  status: HandoffStatus;
  acknowledgementMessageId?: string;
  resultingCommitmentId?: string;
  lastSurfacedIndex?: number;
  ignored?: boolean;
}

export interface Claim extends Provenance {
  agentId: string;
  messageId: string;
  subject: string;
  predicate: string;
  polarity: "positive" | "negative";
  conditions: string[];
  hedged: boolean;
  status: "active" | "retracted" | "superseded";
  answersQuestionId?: string;
  /** an active decision this claim contradicts (§23.1) */
  contradictsDecisionId?: string;
}

export interface Conflict extends Provenance {
  subject: string;
  claimIds: string[];
  status: "candidate" | "confirmed" | "resolved" | "dismissed";
  resolutionMessageIds: string[];
  confirmConfidence: number;
  ignored?: boolean;
}

export type ObjectKind = "question" | "commitment" | "claim" | "conflict" | "handoff" | "decision" | "dependency";

/** A decision the room made (§10.4). subject/value are set when the statement parses as "X is Y". */
export interface Decision extends Provenance {
  statement: string;
  subject?: string;
  value?: string;
  sourceMessageIds: string[];
  status: "active" | "superseded" | "reopened";
  supersededBy?: string;
  decidedBy: string;
}

/** An agent waiting on another object (§10.6). */
export interface Dependency extends Provenance {
  blockedAgentId: string;
  /** the waiting agent's own commitment that is blocked, if any */
  blockedCommitmentId?: string;
  blockingObjectId: string;
  blockingKind: "question" | "commitment" | "handoff" | "decision";
  status: "waiting" | "resolved" | "cancelled";
  resolvedAt?: string;
  notified?: boolean;
}

export interface Transition {
  objectId: string;
  /** "room" for room-level changes such as ready_to_close (§32) */
  kind: ObjectKind | "room";
  from: string | null;
  to: string;
  cause: "event" | "tick" | "command" | "feedback";
  messageId?: string;
  at: string;
}

export type InterventionType =
  | "duplicate_work"
  | "unanswered_question"
  | "conflict_detected"
  | "completion_check"
  | "missing_acknowledgement"
  | "stale_commitment"
  | "repeated_question"
  | "decision_reminder"
  | "dependency_resolved"
  | "dependency_deadlock"
  | "command_reply";

export interface InterventionCandidate {
  type: InterventionType;
  severity: "low" | "medium" | "high";
  involvedAgentIds: string[];
  relatedObjectIds: string[];
  evidenceMessageIds: string[];
  confidence: number;
  urgency: number;
  expectedValue: number;
  blockedAgents: number;
  idempotencyKey: string;
  /** keys of lower-priority candidates merged into this one (§51) */
  absorbedKeys?: string[];
  text: string;
  replyToMessageId?: string;
  createdIndex: number;
}

export interface PostedIntervention {
  candidate: InterventionCandidate;
  postedAt: string;
  postedIndex: number;
  messageId?: string;
  solicited: boolean;
}
