// Metrics (spec §59), computed from room state. The headline number is
// useful_interventions / total_interventions: Chorus should optimize for
// usefulness, not activity.

import type { RoomState } from "./state/room.ts";
import type { PostedIntervention } from "./state/types.ts";

/** Room messages within which an involved agent must act for an intervention to count as useful (§59). */
export const USEFUL_WINDOW = 10;

export type Usefulness = "useful" | "not_useful" | "pending";

/**
 * Useful when, within USEFUL_WINDOW room messages, an involved agent acts on
 * something it cited (answers, acknowledges, re-scopes, resolves) or says
 * `@chorus correct`. Not useful after `@chorus wrong`, or when the window
 * passes with no action. Pending while the window is still open.
 */
export function usefulness(s: RoomState, p: PostedIntervention): Usefulness {
  if (p.feedback === "wrong") return "not_useful";
  if (p.feedback === "correct") return "useful";
  const c = p.candidate;
  const related = new Set(c.relatedObjectIds);
  const involved = new Set(c.involvedAgentIds);
  const acted = s.transitions.some((t) => {
    if (!t.messageId) return false;
    const m = s.message(t.messageId);
    if (!m || !involved.has(m.authorId)) return false;
    if (m.roomIndex <= p.postedIndex || m.roomIndex > p.postedIndex + USEFUL_WINDOW) return false;
    // Acting on a cited object, or re-scoping into new work (duplicate_work).
    return related.has(t.objectId) || (c.type === "duplicate_work" && t.from === null && t.kind === "commitment");
  });
  if (acted) return "useful";
  // Notices that need no reply count as useful unless marked wrong.
  if (c.type === "dependency_resolved" || c.type === "completion_check") return "useful";
  return s.roomIndex - p.postedIndex >= USEFUL_WINDOW ? "not_useful" : "pending";
}

export function metrics(s: RoomState) {
  const qs = [...s.questions.values()];
  const cs = [...s.commitments.values()];
  const xs = [...s.conflicts.values()];
  const unsolicited = s.posted.filter((p) => !p.solicited);
  const byType: Record<string, number> = {};
  for (const p of unsolicited) byType[p.candidate.type] = (byType[p.candidate.type] ?? 0) + 1;
  const verdicts = unsolicited.map((p) => usefulness(s, p));
  const useful = verdicts.filter((v) => v === "useful").length;
  const notUseful = verdicts.filter((v) => v === "not_useful").length;
  const postedKeys = new Set(s.posted.flatMap((p) => [p.candidate.idempotencyKey, ...(p.candidate.absorbedKeys ?? [])]));
  const counter = (k: string) => s.counters.get(k) ?? 0;

  return {
    messages_processed: s.roomIndex,
    questions_detected: qs.length,
    questions_resolved: qs.filter((q) => q.status === "answered").length,
    unanswered_questions_surfaced: byType.unanswered_question ?? 0,
    commitments_created: cs.length,
    commitments_completed: cs.filter((c) => c.status === "completed").length,
    commitments_expired: cs.filter((c) => c.status === "expired").length,
    duplicates_detected: byType.duplicate_work ?? 0,
    duplicates_confirmed: s.posted.filter(
      (p) => p.candidate.type === "duplicate_work" && p.candidate.relatedObjectIds.some((id) => s.commitments.get(id)?.status === "cancelled"),
    ).length,
    claims_recorded: s.claims.size,
    conflicts_detected: xs.filter((x) => x.status !== "candidate").length,
    conflicts_resolved: xs.filter((x) => x.status === "resolved").length,
    handoffs_created: s.handoffs.size,
    dependencies_created: s.dependencies.size,
    decisions_created: s.decisions.size,
    interventions_posted: unsolicited.length,
    interventions_by_type: byType,
    interventions_suppressed: [...s.candidateFirstSeen.keys()].filter((k) => !postedKeys.has(k)).length,
    interventions_followed: useful,
    interventions_ignored: notUseful,
    interventions_pending: verdicts.filter((v) => v === "pending").length,
    command_replies: s.posted.length - unsolicited.length,
    false_positive_feedback: unsolicited.filter((p) => p.feedback === "wrong").length,
    extraction_failures: counter("extraction_failures"),
    llm_calls: counter("llm_calls"),
    llm_input_tokens: counter("llm_input_tokens"),
    llm_output_tokens: counter("llm_output_tokens"),
    llm_budget_fallbacks: counter("llm_budget_fallbacks"),
    llm_rate_limited: counter("llm_rate_limited"),
    extraction_batches: counter("extraction_batches"),
    extraction_backlog_max: counter("extraction_backlog_max"),
    /** the §59 headline metric; null until an intervention has a verdict */
    useful_ratio: useful + notUseful ? useful / (useful + notUseful) : null,
  };
}
