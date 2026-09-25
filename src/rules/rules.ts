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
  /** incremental duplicate-work state; without it every pair is compared */
  duplicates?: DuplicateCache;
  /**
   * True for idempotency keys already posted, absorbed or suppressed. Rules
   * use it to skip building candidates that could never be posted.
   */
  handled?: (key: string) => boolean;
}

/**
 * Each commitment is compared with the others once, when it first becomes
 * eligible; confirmed pairs are remembered. Per-message cost is then linear
 * in the number of commitments, not quadratic. Not persisted: rebuilt after
 * a restart, and must be reset if state is rolled back (IDs get reused).
 */
export interface DuplicateCache {
  checked: Set<string>;
  /** [earlier-checked id, later id, stage-2 confidence] */
  confirmed: Array<[string, string, number]>;
}

export const newDuplicateCache = (): DuplicateCache => ({ checked: new Set(), confirmed: [] });

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
  const cache = ctx.duplicates ?? newDuplicateCache();
  // Compare over every live, non-optional commitment (blocked ones too, so a
  // pair formed while one was blocked is still found once it unblocks)…
  const pool = state
    .activeCommitments()
    .filter((c) => !c.optional && (c.status === "in_progress" || c.status === "accepted" || c.status === "blocked"));
  for (const c of pool) {
    if (cache.checked.has(c.id)) continue;
    for (const other of pool) {
      if (other.id === c.id || !cache.checked.has(other.id) || other.ownerId === c.ownerId) continue;
      if (overlap(contentTokens(c.action), contentTokens(other.action)) < t.duplicateCandidate) continue;
      const v = await ctx.confirmer.duplicate(other.action, c.action);
      if (v.verdict !== "different" && v.confidence >= t.duplicateConfirm) cache.confirmed.push([other.id, c.id, v.confidence]);
    }
    cache.checked.add(c.id);
  }
  // …but only announce pairs where both are currently being worked on.
  const working = (id: string) => {
    const c = state.commitments.get(id);
    return !!c && !c.ignored && (c.status === "in_progress" || c.status === "accepted");
  };
  const out: InterventionCandidate[] = [];
  for (const [ida, idb, confidence] of cache.confirmed) {
    if (!working(ida) || !working(idb)) continue;
    const a = state.commitments.get(ida)!;
    const b = state.commitments.get(idb)!;
      const [first, second] = a.createdIndex <= b.createdIndex ? [a, b] : [b, a];
      if (ctx.handled?.(`duplicate_work:${first.id}:${second.id}`)) continue;
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
        confidence,
        urgency: 0.7,
        expectedValue: 0.8,
        blockedAgents: 0,
        idempotencyKey: `duplicate_work:${first.id}:${second.id}`,
        text: lines.join("\n"),
        createdIndex: state.roomIndex,
      });
  }
  return out;
}

/** Agents waiting on an object through a dependency (§51: "…and Bob is blocked on it"). */
export function blockedOn(state: RoomState, objectId: string): Array<{ agentId: string; depId: string }> {
  return state
    .waitingDependencies()
    .filter(
      (p) =>
        p.blockingObjectId === objectId || state.handoffs.get(p.blockingObjectId)?.resultingCommitmentId === objectId,
    )
    .map((p) => ({ agentId: p.blockedAgentId, depId: p.id }));
}

function blockedLine(state: RoomState, blocked: Array<{ agentId: string; depId: string }>): string[] {
  if (blocked.length === 0) return [];
  const who = blocked.map((b) => `${state.agentName(b.agentId)} (${b.depId})`).join(", ");
  return [`Blocked on it: ${who}.`];
}

/** Two or more blocked agents make a surfaced item high severity (§26 bypass). */
function severityFor(blocked: number): "medium" | "high" {
  return blocked >= 2 ? "high" : "medium";
}

/** §19 — (message count OR wall clock) AND a minimum age, with a resurface cooldown. */
export function unansweredQuestions(state: RoomState, ctx: RuleContext): InterventionCandidate[] {
  const u = ctx.config.unanswered;
  const out: InterventionCandidate[] = [];
  for (const q of state.openQuestions()) {
    // Someone is working on it (the stale-commitment rule covers that), or it
    // repeats an answered question (the repeated-question rule covers that).
    if (q.ignored || isClaimed(state, q) || q.duplicateOf) continue;
    const since = q.ackIndex ?? q.createdIndex;
    const subsequent = state.roomIndex - since;
    const ageSeconds = (ctx.now.getTime() - new Date(q.createdAt).getTime()) / 1000;
    const due = subsequent >= u.minSubsequentMessages || ageSeconds >= u.maxWaitSeconds;
    if (!due || ageSeconds < u.minSeconds) continue;
    if (q.lastSurfacedIndex !== undefined && state.roomIndex - q.lastSurfacedIndex < u.resurfaceCooldownMessages) {
      continue;
    }
    const blocked = blockedOn(state, q.id);
    out.push({
      type: "unanswered_question",
      severity: severityFor(blocked.length),
      involvedAgentIds: [q.askerId, ...q.targetIds, ...blocked.map((b) => b.agentId)],
      relatedObjectIds: [q.id, ...blocked.map((b) => b.depId)],
      evidenceMessageIds: [q.sourceMessageId],
      confidence: q.extractorConfidence,
      urgency: Math.min(1, 0.6 + subsequent / 60),
      expectedValue: 0.8,
      blockedAgents: blocked.length,
      idempotencyKey: `unanswered_question:${q.id}:${q.lastSurfacedIndex ?? 0}`,
      text: [
        "Still unanswered:",
        "",
        `${q.id} — ${q.text}`,
        "",
        `Asked by ${state.agentName(q.askerId)} at ${state.cite(q.sourceMessageId)}.`,
        ...blockedLine(state, blocked),
      ].join("\n"),
      replyToMessageId: q.sourceMessageId,
      createdIndex: state.roomIndex,
    });
  }
  return out;
}

/**
 * §20 — the recipient has kept talking without acknowledging a handoff. This
 * is evidence the handoff was missed, which a timer alone cannot give.
 */
export function missingAcknowledgements(state: RoomState, ctx: RuleContext): InterventionCandidate[] {
  const cfg = ctx.config.handoff;
  const out: InterventionCandidate[] = [];
  for (const h of state.pendingHandoffs()) {
    if (h.ignored) continue;
    const since = h.lastSurfacedIndex ?? h.createdIndex;
    const recipientMessages = state.agentMessagesAfter(h.toAgentId, h.createdIndex);
    if (recipientMessages < cfg.minTargetMessages) continue;
    if (h.lastSurfacedIndex !== undefined && state.roomIndex - since < cfg.resurfaceCooldownMessages) continue;
    const blocked = blockedOn(state, h.id).filter((b) => b.agentId !== h.fromAgentId);
    out.push({
      type: "missing_acknowledgement",
      // The sender is waiting on it too, so count them as blocked.
      severity: severityFor(blocked.length + 1),
      involvedAgentIds: [h.toAgentId, h.fromAgentId, ...blocked.map((b) => b.agentId)],
      relatedObjectIds: [h.id, ...blocked.map((b) => b.depId)],
      evidenceMessageIds: [h.sourceMessageId],
      confidence: h.extractorConfidence,
      urgency: Math.min(1, 0.6 + recipientMessages / 20),
      expectedValue: 0.8,
      blockedAgents: blocked.length + 1,
      idempotencyKey: `missing_acknowledgement:${h.id}:${h.lastSurfacedIndex ?? 0}`,
      text: [
        `${state.agentName(h.toAgentId)}: handoff ${h.id} from ${state.agentName(h.fromAgentId)} has not been acknowledged.`,
        "",
        `${h.id} — ${h.action} (${state.cite(h.sourceMessageId)})`,
        "",
        `Reply to accept or decline. You have posted ${recipientMessages} messages since.`,
        ...blockedLine(state, blocked),
      ].join("\n"),
      replyToMessageId: h.sourceMessageId,
      createdIndex: state.roomIndex,
    });
  }
  return out;
}

/**
 * §21 — a commitment is stale on several signals, not just age: time, room
 * activity, and the owner talking about other things without an update.
 */
export function staleCommitments(state: RoomState, ctx: RuleContext): InterventionCandidate[] {
  const cfg = ctx.config.stale;
  const out: InterventionCandidate[] = [];
  for (const c of state.activeCommitments()) {
    if (c.optional || c.ignored || c.status !== "in_progress") continue;
    if (c.lastSurfacedIndex !== undefined && state.roomIndex - c.lastSurfacedIndex < cfg.resurfaceCooldownMessages) {
      continue;
    }
    const ageSeconds = (ctx.now.getTime() - new Date(c.updatedAt).getTime()) / 1000;
    const roomSince = state.roomIndex - c.updatedIndex;
    const ownerSince = state.agentMessagesAfter(c.ownerId, c.updatedIndex);
    const blocked = blockedOn(state, c.id);
    const dependents = blocked.length;
    const score =
      0.35 * Math.min(ageSeconds / cfg.ageRefSeconds, 1) +
      0.25 * Math.min(roomSince / cfg.roomRefMessages, 1) +
      0.2 * Math.min(ownerSince / 5, 1) +
      0.2 * Math.min(dependents / 2, 1);
    if (score < ctx.config.thresholds.stale) continue;
    const minutes = Math.round(ageSeconds / 60);
    out.push({
      type: "stale_commitment",
      severity: severityFor(dependents),
      involvedAgentIds: [c.ownerId, ...blocked.map((b) => b.agentId)],
      relatedObjectIds: [c.id, ...blocked.map((b) => b.depId)],
      evidenceMessageIds: [c.sourceMessageId],
      confidence: Math.min(0.95, score + 0.1),
      urgency: score,
      expectedValue: 0.8,
      blockedAgents: dependents,
      idempotencyKey: `stale_commitment:${c.id}:${c.lastSurfacedIndex ?? 0}`,
      text: [
        `No update on ${c.id} for ${roomSince} messages (${minutes} min):`,
        "",
        `${state.agentName(c.ownerId)} → ${c.action} (${state.cite(c.sourceMessageId)})`,
        "",
        `${state.agentName(c.ownerId)}, is this still in progress? "@chorus resolved ${c.id}" if it's done.`,
        ...blockedLine(state, blocked),
      ].join("\n"),
      replyToMessageId: c.sourceMessageId,
      createdIndex: state.roomIndex,
    });
  }
  return out;
}

/** §23 — a new question repeats one already answered; quote the answer. */
export function repeatedQuestions(state: RoomState, ctx: RuleContext): InterventionCandidate[] {
  const out: InterventionCandidate[] = [];
  const repeats = state.openQuestions().filter((q) => q.duplicateOf && !q.ignored && !ctx.handled?.(`repeated_question:${q.id}`));
  if (repeats.length === 0) return out;
  // Index answering claims once per pass, not once per question.
  const answersFor = new Map<string, Claim[]>();
  for (const k of state.claims.values()) {
    if (k.answersQuestionId && k.status === "active") answersFor.set(k.answersQuestionId, [...(answersFor.get(k.answersQuestionId) ?? []), k]);
  }
  for (const q of repeats) {
    const original = state.questions.get(q.duplicateOf!);
    if (!original) continue;
    const answers = answersFor.get(original.id) ?? [];
    const answerMsgs = answers.length ? answers.map((k) => k.messageId) : original.answerMessageIds;
    const quoted = answerMsgs
      .map((id) => state.message(id))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => `${state.agentName(m.authorId)} (#${m.seq}): ${m.text}`);
    if (quoted.length === 0) continue;
    out.push({
      type: "repeated_question",
      severity: "medium",
      involvedAgentIds: [q.askerId],
      relatedObjectIds: [q.id, original.id],
      evidenceMessageIds: [q.sourceMessageId, original.sourceMessageId, ...answerMsgs],
      confidence: 0.92,
      urgency: 0.8,
      expectedValue: 0.9,
      blockedAgents: 0,
      idempotencyKey: `repeated_question:${q.id}`,
      text: [
        `This appears to match ${original.id}, which was previously answered.`,
        "",
        `${original.id} — ${original.text} (${state.cite(original.sourceMessageId)})`,
        ...quoted.map((line) => `Answer: ${line}`),
      ].join("\n"),
      replyToMessageId: q.sourceMessageId,
      createdIndex: state.roomIndex,
    });
  }
  return out;
}

/** §23.1 — a claim contradicts an active decision. */
export function decisionReminders(state: RoomState, ctx: RuleContext): InterventionCandidate[] {
  const out: InterventionCandidate[] = [];
  for (const k of state.activeClaims()) {
    const d = k.contradictsDecisionId ? state.decisions.get(k.contradictsDecisionId) : undefined;
    if (!d || d.status !== "active") continue;
    if (ctx.handled?.(`decision_reminder:${d.id}:${k.id}`)) continue;
    out.push({
      type: "decision_reminder",
      severity: "medium",
      involvedAgentIds: [k.agentId],
      relatedObjectIds: [d.id, k.id],
      evidenceMessageIds: [k.messageId, ...d.sourceMessageIds],
      confidence: 0.88,
      urgency: 0.7,
      expectedValue: 0.8,
      blockedAgents: 0,
      idempotencyKey: `decision_reminder:${d.id}:${k.id}`,
      text: [
        `Note: this differs from ${d.id} — "${d.statement}" (decided at ${state.cite(d.sourceMessageIds[0]!)}).`,
        `Reply "@chorus reopen ${d.id}" if the room is revisiting it.`,
      ].join("\n"),
      replyToMessageId: k.messageId,
      createdIndex: state.roomIndex,
    });
  }
  return out;
}

/** §24 — tell a waiting agent their dependency resolved, once. */
export function resolvedDependencies(state: RoomState, _ctx: RuleContext): InterventionCandidate[] {
  const out: InterventionCandidate[] = [];
  for (const p of state.dependencies.values()) {
    if (p.status !== "resolved" || p.notified) continue;
    const blocker = state.object(p.blockingObjectId);
    const what =
      blocker && "action" in blocker
        ? `"${blocker.action}"`
        : blocker && "text" in blocker
          ? `"${blocker.text}"`
          : blocker && "statement" in blocker
            ? `"${blocker.statement}"`
            : "";
    const resolvedMsg = p.derivedFromMessageIds.at(-1);
    const by = resolvedMsg ? state.message(resolvedMsg) : undefined;
    const alreadyDone = p.resolvedOnCreate === true;
    const blockerStatus = blocker && "status" in blocker ? blocker.status : undefined;
    const ended =
      blockerStatus === "expired"
        ? "expired without being completed (deadline passed)"
        : blockerStatus === "cancelled" || blockerStatus === "declined" || blockerStatus === "withdrawn"
          ? `was ${blockerStatus}`
          : "finished";
    out.push({
      type: "dependency_resolved",
      severity: "medium",
      involvedAgentIds: [p.blockedAgentId],
      relatedObjectIds: [p.id, p.blockingObjectId],
      evidenceMessageIds: p.derivedFromMessageIds,
      confidence: 0.93,
      urgency: 0.8,
      expectedValue: 0.9,
      blockedAgents: 1,
      idempotencyKey: `dependency_resolved:${p.id}`,
      text: alreadyDone
        ? `${state.agentName(p.blockedAgentId)} — ${p.blockingObjectId} ${what} is already done; nothing to wait for.`
        : `${state.agentName(p.blockedAgentId)} — ${p.id} is resolved: ${p.blockingObjectId} ${what} ${ended}${by && ended === "finished" ? ` at #${by.seq}` : ""}.`,
      createdIndex: state.roomIndex,
    });
  }
  return out;
}

/** Who has to act for a blocking object to finish. */
function ownerOf(state: RoomState, objectId: string): string | undefined {
  const c = state.commitments.get(objectId);
  if (c) return c.ownerId;
  const h = state.handoffs.get(objectId);
  if (h) return h.resultingCommitmentId ? state.commitments.get(h.resultingCommitmentId)?.ownerId : h.toAgentId;
  const q = state.questions.get(objectId);
  if (q && q.targetIds.length === 1) return q.targetIds[0];
  return undefined;
}

/**
 * §26 — explicit dependency deadlock: agents waiting on each other in a
 * cycle. High severity, so it bypasses the 1-per-8-messages limit.
 */
export function dependencyDeadlocks(state: RoomState, _ctx: RuleContext): InterventionCandidate[] {
  // waits-for graph: agent → [{ owner, dep }]
  const edges = new Map<string, Array<{ to: string; depId: string; objectId: string }>>();
  for (const p of state.waitingDependencies()) {
    const to = ownerOf(state, p.blockingObjectId);
    if (!to || to === p.blockedAgentId) continue;
    const list = edges.get(p.blockedAgentId) ?? [];
    list.push({ to, depId: p.id, objectId: p.blockingObjectId });
    edges.set(p.blockedAgentId, list);
  }
  const out: InterventionCandidate[] = [];
  const reported = new Set<string>();
  const dfs = (start: string, node: string, path: Array<{ from: string; to: string; depId: string; objectId: string }>) => {
    for (const e of edges.get(node) ?? []) {
      const step = { from: node, ...e };
      if (e.to === start) {
        const cycle = [...path, step];
        const key = cycle.map((s) => s.depId).sort().join(",");
        if (reported.has(key)) continue;
        reported.add(key);
        out.push({
          type: "dependency_deadlock",
          severity: "high",
          involvedAgentIds: cycle.map((s) => s.from),
          relatedObjectIds: cycle.map((s) => s.depId),
          evidenceMessageIds: cycle.flatMap((s) => state.dependencies.get(s.depId)!.derivedFromMessageIds.slice(0, 1)),
          confidence: 0.93,
          urgency: 1,
          expectedValue: 1,
          blockedAgents: cycle.length,
          idempotencyKey: `dependency_deadlock:${key}`,
          text: [
            "Possible deadlock — these agents are waiting on each other:",
            "",
            ...cycle.map(
              (s) =>
                `${state.agentName(s.from)} waits on ${s.objectId} (${state.agentName(s.to)}) — ${s.depId}, ${state.cite(state.dependencies.get(s.depId)!.derivedFromMessageIds[0]!)}`,
            ),
            "",
            "One of you needs to go first, or drop the dependency.",
          ].join("\n"),
          createdIndex: state.roomIndex,
        });
      } else if (!path.some((s) => s.from === e.to) && e.to !== node) {
        dfs(start, e.to, [...path, step]);
      }
    }
  };
  for (const agent of edges.keys()) dfs(agent, agent, []);
  return out;
}

/** §22 — announce each confirmed conflict once. */
export function conflicts(state: RoomState, ctx: RuleContext): InterventionCandidate[] {
  const out: InterventionCandidate[] = [];
  for (const x of state.conflicts.values()) {
    if (x.status !== "confirmed" || x.ignored) continue;
    if (ctx.handled?.(`conflict_detected:${x.id}:${x.claimIds.length}`)) continue;
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
  pendingHandoffs: ReturnType<RoomState["pendingHandoffs"]>;
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
    pendingHandoffs: state.pendingHandoffs(),
    requiredCommitments: active.filter((c) => !c.optional),
    optionalCommitments: active.filter((c) => c.optional),
    confirmedConflicts: unresolved.filter((x) => x.status === "confirmed"),
    candidateConflicts: unresolved.filter((x) => x.status === "candidate"),
  };
  return {
    ...r,
    complete:
      r.openQuestions.length === 0 &&
      r.pendingHandoffs.length === 0 &&
      r.requiredCommitments.length === 0 &&
      r.confirmedConflicts.length === 0,
  };
}

export function formatCompletion(state: RoomState, r: CompletionReport): string {
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  if (r.complete) {
    const lines = [
      "READY TO CLOSE",
      "",
      "0 open questions",
      "0 pending handoffs",
      "0 unresolved conflicts",
      "0 required active commitments",
    ];
    for (const c of r.optionalCommitments) {
      lines.push(`optional follow-up: ${c.id} (${state.agentName(c.ownerId)}) "${c.action}"`);
    }
    for (const x of r.candidateConflicts) lines.push(`unconfirmed conflict (warning): ${x.id} — ${x.subject}`);
    for (const c of state.commitments.values()) {
      if (c.status === "expired") {
        lines.push(`expired without completion (warning): ${c.id} (${state.agentName(c.ownerId)}) "${c.action}"`);
      }
    }
    lines.push("", "This is coordination status only; it does not mean the task itself succeeded.");
    return lines.join("\n");
  }
  const lines = ["NOT READY", ""];
  if (r.openQuestions.length) {
    lines.push(`${plural(r.openQuestions.length, "open question")}:`);
    for (const q of r.openQuestions) lines.push(`${q.id} — ${q.text} (${state.cite(q.sourceMessageId)})`);
  }
  if (r.pendingHandoffs.length) {
    lines.push(`${plural(r.pendingHandoffs.length, "pending handoff")}:`);
    for (const h of r.pendingHandoffs) {
      lines.push(`${h.id} — ${state.agentName(h.fromAgentId)} → ${state.agentName(h.toAgentId)}: ${h.action}`);
    }
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
export function completion(state: RoomState, ctx: RuleContext): InterventionCandidate[] {
  if (state.completionAnnounced || state.mode !== "facilitate") return [];
  const hadObligations = state.questions.size + state.commitments.size + state.conflicts.size + state.handoffs.size > 0;
  const last = state.lastAgentMessage();
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
