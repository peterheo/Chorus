// MVP coordination rules (spec §18, §19, §22, §25). Each rule reads state and
// returns intervention candidates; none of them mutates state.

import type { ChorusConfig } from "../config.ts";
import type { Confirmer } from "../confirm.ts";
import { contentTokens, overlap, textSimilarity } from "../similarity.ts";
import { isClaimed } from "../state/engine.ts";
import type { RoomState } from "../state/room.ts";
import type { Claim, InterventionCandidate, Question } from "../state/types.ts";

export interface RuleContext {
  config: ChorusConfig;
  confirmer: Confirmer;
  now: Date;
}

export function describeClaim(k: Claim): string {
  const cond = k.conditions.length ? ` (${k.conditions.join(", ")})` : "";
  return `${k.polarity === "negative" ? "not " : ""}${k.predicate}${cond}${k.hedged ? " — hedged" : ""}`;
}

function unclaimedItem(state: RoomState, excludeAgents: string[], near: string): Question | undefined {
  const open = state
    .openQuestions()
    .filter((q) => !isClaimed(state, q) && !q.ignored && !excludeAgents.includes(q.askerId));
  const requests = open.filter((q) => q.kind === "request");
  const pool = requests.length ? requests : open;
  if (pool.length === 0) return undefined;
  // Most similar to the duplicate work, ties broken by age (oldest first).
  return pool
    .map((q) => ({ q, s: textSimilarity(q.text, near) }))
    .sort((a, b) => b.s - a.s || a.q.createdIndex - b.q.createdIndex)[0]!.q;
}

/** §18 — two agents doing the same work. Two-stage: lexical candidates, then confirmation. */
export async function duplicateWork(state: RoomState, ctx: RuleContext): Promise<InterventionCandidate[]> {
  const t = ctx.config.thresholds;
  const active = state
    .activeCommitments()
    .filter((c) => !c.optional && !c.ignored && (c.status === "in_progress" || c.status === "accepted"));
  const out: InterventionCandidate[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.ownerId === b.ownerId) continue;
      if (overlap(contentTokens(a.action), contentTokens(b.action)) < t.duplicateCandidate) continue;
      const v = await ctx.confirmer.duplicate(a.action, b.action);
      if (v.verdict === "different" || v.confidence < t.duplicateConfirm) continue;

      const [first, second] = a.createdIndex <= b.createdIndex ? [a, b] : [b, a];
      const free = unclaimedItem(state, [], second.action);
      const lines = [
        "Potential duplicate work:",
        "",
        `${state.agentName(first.ownerId)} → ${first.id} ${first.action} (${state.cite(first.sourceMessageId)})`,
        `${state.agentName(second.ownerId)} → ${second.id} ${second.action} (${state.cite(second.sourceMessageId)})`,
        "",
        `${state.agentName(first.ownerId)} started first.`,
      ];
      if (free) {
        lines.push(
          `Still unclaimed: ${free.id} — ${free.text} (${state.agentName(free.askerId)}, ${state.cite(free.sourceMessageId)})`,
        );
      }
      out.push({
        type: "duplicate_work",
        severity: "medium",
        involvedAgentIds: [first.ownerId, second.ownerId],
        relatedObjectIds: [first.id, second.id],
        evidenceMessageIds: [first.sourceMessageId, second.sourceMessageId],
        confidence: v.confidence,
        urgency: 0.7,
        expectedValue: 0.8,
        blockedAgents: 0,
        idempotencyKey: `duplicate_work:${first.id}:${second.id}`,
        text: lines.join("\n"),
        createdIndex: state.roomIndex,
      });
    }
  }
  return out;
}

/** §19 — (message count OR wall clock) AND a minimum age, with a resurface cooldown. */
export function unansweredQuestions(state: RoomState, ctx: RuleContext): InterventionCandidate[] {
  const u = ctx.config.unanswered;
  const out: InterventionCandidate[] = [];
  for (const q of state.openQuestions()) {
    // Someone is working on it; a stale-commitment rule (post-MVP) covers that case.
    if (q.ignored || isClaimed(state, q)) continue;
    const since = q.ackIndex ?? q.createdIndex;
    const subsequent = state.roomIndex - since;
    const ageSeconds = (ctx.now.getTime() - new Date(q.createdAt).getTime()) / 1000;
    const due = subsequent >= u.minSubsequentMessages || ageSeconds >= u.maxWaitSeconds;
    if (!due || ageSeconds < u.minSeconds) continue;
    if (q.lastSurfacedIndex !== undefined && state.roomIndex - q.lastSurfacedIndex < u.resurfaceCooldownMessages) {
      continue;
    }
    out.push({
      type: "unanswered_question",
      severity: "medium",
      involvedAgentIds: [q.askerId, ...q.targetIds],
      relatedObjectIds: [q.id],
      evidenceMessageIds: [q.sourceMessageId],
      confidence: q.extractorConfidence,
      urgency: Math.min(1, 0.6 + subsequent / 60),
      expectedValue: 0.8,
      blockedAgents: 0,
      idempotencyKey: `unanswered_question:${q.id}:${q.lastSurfacedIndex ?? 0}`,
      text: [
        "Still unanswered:",
        "",
        `${q.id} — ${q.text}`,
        "",
        `Asked by ${state.agentName(q.askerId)} at ${state.cite(q.sourceMessageId)}.`,
      ].join("\n"),
      replyToMessageId: q.sourceMessageId,
      createdIndex: state.roomIndex,
    });
  }
  return out;
}

/** §22 — announce each confirmed conflict once. */
export function conflicts(state: RoomState, _ctx: RuleContext): InterventionCandidate[] {
  const out: InterventionCandidate[] = [];
  for (const x of state.conflicts.values()) {
    if (x.status !== "confirmed" || x.ignored) continue;
    const claims = x.claimIds.map((id) => state.claims.get(id)!).filter((k) => k.status === "active");
    out.push({
      type: "conflict_detected",
      severity: "high",
      involvedAgentIds: [...new Set(claims.map((k) => k.agentId))],
      relatedObjectIds: [x.id, ...claims.map((k) => k.id)],
      evidenceMessageIds: claims.map((k) => k.messageId),
      confidence: x.confirmConfidence,
      urgency: 0.8,
      expectedValue: 0.9,
      blockedAgents: 0,
      idempotencyKey: `conflict_detected:${x.id}:${x.claimIds.length}`,
      text: [
        `Unresolved conflict ${x.id}: ${x.subject}`,
        "",
        ...claims.map((k) => `${state.agentName(k.agentId)} (${state.cite(k.messageId)}): ${describeClaim(k)}`),
        "",
        "No resolution has been recorded.",
      ].join("\n"),
      createdIndex: state.roomIndex,
    });
  }
  return out;
}

export interface CompletionReport {
  complete: boolean;
  openQuestions: Question[];
  requiredCommitments: ReturnType<RoomState["activeCommitments"]>;
  optionalCommitments: ReturnType<RoomState["activeCommitments"]>;
  confirmedConflicts: ReturnType<RoomState["unresolvedConflicts"]>;
  candidateConflicts: ReturnType<RoomState["unresolvedConflicts"]>;
}

/** §25 — coordination-complete, not task success. */
export function completionReport(state: RoomState): CompletionReport {
  const active = state.activeCommitments();
  const unresolved = state.unresolvedConflicts();
  const r = {
    openQuestions: state.openQuestions(),
    requiredCommitments: active.filter((c) => !c.optional),
    optionalCommitments: active.filter((c) => c.optional),
    confirmedConflicts: unresolved.filter((x) => x.status === "confirmed"),
    candidateConflicts: unresolved.filter((x) => x.status === "candidate"),
  };
  return {
    ...r,
    complete: r.openQuestions.length === 0 && r.requiredCommitments.length === 0 && r.confirmedConflicts.length === 0,
  };
}

export function formatCompletion(state: RoomState, r: CompletionReport): string {
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  if (r.complete) {
    const lines = [
      "READY TO CLOSE",
      "",
      "0 open questions",
      "0 unresolved conflicts",
      "0 required active commitments",
    ];
    for (const c of r.optionalCommitments) {
      lines.push(`optional follow-up: ${c.id} (${state.agentName(c.ownerId)}) "${c.action}"`);
    }
    for (const x of r.candidateConflicts) lines.push(`unconfirmed conflict (warning): ${x.id} — ${x.subject}`);
    lines.push("", "This is coordination status only; it does not mean the task itself succeeded.");
    return lines.join("\n");
  }
  const lines = ["NOT READY", ""];
  if (r.openQuestions.length) {
    lines.push(`${plural(r.openQuestions.length, "open question")}:`);
    for (const q of r.openQuestions) lines.push(`${q.id} — ${q.text} (${state.cite(q.sourceMessageId)})`);
  }
  if (r.requiredCommitments.length) {
    lines.push(`${plural(r.requiredCommitments.length, "active commitment")}:`);
    for (const c of r.requiredCommitments) lines.push(`${c.id} — ${state.agentName(c.ownerId)}: ${c.action} [${c.status}]`);
  }
  if (r.confirmedConflicts.length) {
    lines.push(`${plural(r.confirmedConflicts.length, "unresolved conflict")}:`);
    for (const x of r.confirmedConflicts) lines.push(`${x.id} — ${x.subject}`);
  }
  return lines.join("\n");
}

export const COMPLETION_QUIET_SECONDS = 60;

/**
 * §25 — in facilitate mode, announce once that the room is clear. Evaluated
 * on ticks only, after the room has been quiet for a minute, so a brief
 * moment with nothing open mid-conversation is not announced.
 */
export function completion(
  state: RoomState,
  ctx: RuleContext,
  announced: { value: boolean },
): InterventionCandidate[] {
  if (announced.value || state.mode !== "facilitate") return [];
  const hadObligations = state.questions.size + state.commitments.size + state.conflicts.size > 0;
  const last = state.messages.filter((m) => !m.isFromChorus).at(-1);
  const quiet = last ? (ctx.now.getTime() - new Date(last.timestamp).getTime()) / 1000 : 0;
  if (!hadObligations || quiet < COMPLETION_QUIET_SECONDS) return [];
  const r = completionReport(state);
  if (!r.complete) return [];
  return [
    {
      type: "completion_check",
      severity: "medium",
      involvedAgentIds: [],
      relatedObjectIds: [],
      evidenceMessageIds: [],
      confidence: 0.95,
      urgency: 0.6,
      expectedValue: 0.9,
      blockedAgents: 0,
      idempotencyKey: "completion_check:ready",
      text: formatCompletion(state, r),
      createdIndex: state.roomIndex,
    },
  ];
}
