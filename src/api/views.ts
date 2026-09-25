// Machine-readable views of room state (spec §31, §32, §41). Pure functions
// from RoomState to JSON; the HTTP layer only routes and authenticates.

import { completionReport } from "../rules/rules.ts";
import type { RoomState } from "../state/room.ts";
import type { Transition } from "../state/types.ts";

function count<T>(items: Iterable<T>, pred: (x: T) => boolean): number {
  let n = 0;
  for (const x of items) if (pred(x)) n++;
  return n;
}

/** GET /v1/rooms/:roomId/state */
export function stateView(roomId: string, s: RoomState) {
  const qs = [...s.questions.values()];
  const cs = [...s.commitments.values()];
  const xs = [...s.conflicts.values()];
  return {
    room_id: roomId,
    mode: s.mode,
    as_of_sequence: s.lastProcessedSeq,
    questions: {
      open: count(qs, (q) => q.status === "open" || q.status === "acknowledged"),
      answered: count(qs, (q) => q.status === "answered"),
    },
    commitments: {
      in_progress: count(cs, (c) => c.status === "in_progress"),
      blocked: count(cs, (c) => c.status === "blocked"),
      optional: count(cs, (c) => c.optional && ["proposed", "accepted", "in_progress"].includes(c.status)),
      completed: count(cs, (c) => c.status === "completed"),
    },
    handoffs: { pending: s.pendingHandoffs().length },
    conflicts: {
      confirmed: count(xs, (x) => x.status === "confirmed"),
      candidate: count(xs, (x) => x.status === "candidate"),
    },
    dependencies: { waiting: s.waitingDependencies().length },
    decisions: { active: s.activeDecisions().length },
    coordination_complete: completionReport(s).complete,
  };
}

/** GET /v1/rooms/:roomId/open-items */
export function openItemsView(s: RoomState) {
  const age = (createdIndex: number) => s.roomIndex - createdIndex;
  const seq = (messageId: string) => s.message(messageId)?.seq ?? null;
  const items: Array<Record<string, unknown>> = [];
  for (const q of s.openQuestions()) {
    items.push({
      type: q.kind,
      id: q.id,
      summary: q.text,
      owner: null,
      asked_by: q.askerId,
      status: q.status,
      claimed_by: q.claimedByCommitmentId ?? null,
      age_messages: age(q.createdIndex),
      source_message: seq(q.sourceMessageId),
    });
  }
  for (const c of s.activeCommitments()) {
    items.push({
      type: "commitment",
      id: c.id,
      summary: c.action,
      owner: c.ownerId,
      status: c.status,
      optional: c.optional,
      age_messages: age(c.createdIndex),
      source_message: seq(c.sourceMessageId),
    });
  }
  for (const h of s.pendingHandoffs()) {
    items.push({
      type: "handoff",
      id: h.id,
      summary: h.action,
      owner: h.toAgentId,
      from: h.fromAgentId,
      status: h.status,
      age_messages: age(h.createdIndex),
      source_message: seq(h.sourceMessageId),
    });
  }
  for (const x of s.unresolvedConflicts()) {
    items.push({
      type: "conflict",
      id: x.id,
      summary: x.subject,
      owner: null,
      status: x.status,
      claims: x.claimIds,
      age_messages: age(x.createdIndex),
    });
  }
  for (const p of s.waitingDependencies()) {
    items.push({
      type: "dependency",
      id: p.id,
      summary: `${p.blockedAgentId} waiting on ${p.blockingObjectId}`,
      owner: p.blockedAgentId,
      status: p.status,
      blocking: p.blockingObjectId,
      age_messages: age(p.createdIndex),
    });
  }
  return { items };
}

/** GET /v1/rooms/:roomId/decisions — current and superseded (§31). */
export function decisionsView(s: RoomState) {
  return {
    decisions: [...s.decisions.values()].map((d) => ({
      id: d.id,
      statement: d.statement,
      status: d.status,
      decided_by: d.decidedBy,
      superseded_by: d.supersededBy ?? null,
      source_messages: d.sourceMessageIds.map((m) => s.message(m)?.seq ?? null),
    })),
  };
}

/** GET /v1/rooms/:roomId/agents/:agentId/context (§31). */
export function agentContextView(s: RoomState, agentId: string) {
  return {
    agent_id: agentId,
    display_name: s.agents.get(agentId)?.displayName ?? null,
    commitments: s.activeCommitments().filter((c) => c.ownerId === agentId).map((c) => c.id),
    waiting_on: s
      .waitingDependencies()
      .filter((p) => p.blockedAgentId === agentId)
      .map((p) => p.blockingObjectId),
    handoffs_to_you: s.pendingHandoffs().filter((h) => h.toAgentId === agentId).map((h) => h.id),
    handoffs_from_you: s.pendingHandoffs().filter((h) => h.fromAgentId === agentId).map((h) => h.id),
    questions_targeted_to_you: s
      .openQuestions()
      .filter((q) => q.targetIds.includes(agentId))
      .map((q) => q.id),
    your_open_questions: s.openQuestions().filter((q) => q.askerId === agentId).map((q) => q.id),
  };
}

/** GET /v1/rooms/:roomId/objects/:shortId/history (§41). */
export function historyView(s: RoomState, id: string) {
  const obj = s.object(id);
  if (!obj) return null;
  return {
    object: obj,
    transitions: s.transitions
      .filter((t) => t.objectId === id)
      .map((t) => ({ ...t, message: t.messageId ? (s.message(t.messageId) ?? null) : null })),
    source_messages: obj.derivedFromMessageIds
      .map((m) => s.message(m))
      .filter((m) => m !== undefined),
  };
}

/** §32 event names, derived from state transitions. */
const EVENT_NAMES: Record<string, Record<string, string>> = {
  question: { open: "question.opened", answered: "question.answered", acknowledged: "question.acknowledged", withdrawn: "question.withdrawn" },
  commitment: {
    in_progress: "commitment.created",
    proposed: "commitment.created",
    completed: "commitment.completed",
    blocked: "commitment.blocked",
    cancelled: "commitment.cancelled",
    expired: "commitment.expired",
  },
  handoff: {
    pending: "handoff.pending",
    accepted: "handoff.accepted",
    declined: "handoff.declined",
    completed: "handoff.completed",
    expired: "handoff.expired",
  },
  claim: { active: "claim.recorded", retracted: "claim.retracted" },
  conflict: { confirmed: "conflict.detected", candidate: "conflict.candidate", resolved: "conflict.resolved", dismissed: "conflict.dismissed" },
  dependency: { waiting: "dependency.waiting", resolved: "dependency.resolved" },
  decision: { active: "decision.created", superseded: "decision.superseded", reopened: "decision.reopened" },
  room: { ready_to_close: "room.ready_to_close", active: "room.reopened" },
};

export interface RoomEvent {
  /** position in the room's transition log; the SSE `id` */
  id: number;
  event: string;
  sequence: number | null;
  data: Record<string, unknown>;
}

export function transitionEvent(s: RoomState, t: Transition, index: number): RoomEvent | null {
  // A commitment moving back to in_progress is an unblock, not a creation.
  let name = EVENT_NAMES[t.kind]?.[t.to];
  if (t.kind === "commitment" && t.to === "in_progress" && t.from !== null) name = "commitment.unblocked";
  if (!name) return null;
  return {
    id: index,
    event: name,
    sequence: t.messageId ? (s.message(t.messageId)?.seq ?? null) : null,
    data: { [`${t.kind}_id`]: t.objectId, from: t.from, to: t.to, cause: t.cause, reason: t.reason ?? null, at: t.at },
  };
}
