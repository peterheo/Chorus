// Intervention policy (spec §26, §51, §71): mode filter, score, dedup,
// rate limits, and a TTL for candidates that keep getting rate-limited.

import type { ChorusConfig } from "./config.ts";
import type { RoomState } from "./state/room.ts";
import type { InterventionCandidate } from "./state/types.ts";

const SEVERITY = { low: 0.2, medium: 0.5, high: 1.0 } as const;

export function score(state: RoomState, c: InterventionCandidate): number {
  // Only unsolicited Chorus messages count as noise; replies to commands don't.
  const unsolicitedIds = new Set(state.posted.filter((p) => !p.solicited && p.messageId).map((p) => p.messageId));
  const recentChorus = state.messages
    .slice(-10)
    .filter((m) => m.isFromChorus && unsolicitedIds.has(m.id)).length;
  return (
    0.3 * SEVERITY[c.severity] +
    0.2 * c.urgency +
    0.2 * c.confidence +
    0.15 * c.expectedValue +
    0.15 * Math.min(c.blockedAgents / 3, 1) -
    // each Chorus message among the last 10 costs 0.05 (spec §26 penalty)
    0.05 * recentChorus
  );
}

export interface Decision {
  post: InterventionCandidate | null;
  suppressed: Array<{ candidate: InterventionCandidate; reason: string }>;
}

/**
 * The stable part of an idempotency key. Recurring nudges add a resurface
 * counter ("unanswered_question:Q1:14"); feedback applies to all of them.
 */
export function keyFamily(key: string): string {
  const parts = key.split(":");
  return /^(unanswered_question|missing_acknowledgement|stale_commitment)$/.test(parts[0]!) ? parts.slice(0, 2).join(":") : key;
}

export class InterventionPolicy {
  constructor(private readonly config: () => ChorusConfig) {}

  private allowedInMode(state: RoomState, c: InterventionCandidate): boolean {
    switch (state.mode) {
      case "observe":
        return false;
      case "assist":
        // §71: only high-confidence alerts of these types.
        return (
          ["conflict_detected", "repeated_question", "dependency_resolved", "dependency_deadlock"].includes(c.type) &&
          c.confidence >= 0.9
        );
      case "facilitate":
        return true;
    }
  }

  choose(state: RoomState, candidates: InterventionCandidate[], now: Date): Decision {
    const cfg = this.config().interventions;
    const suppressed: Decision["suppressed"] = [];
    const postedKeys = new Set(
      state.posted.flatMap((p) => [p.candidate.idempotencyKey, ...(p.candidate.absorbedKeys ?? [])]),
    );

    const unsolicited = state.posted.filter((p) => !p.solicited);
    const last = unsolicited[unsolicited.length - 1];
    const messagesSinceLast = last ? state.roomIndex - last.postedIndex : Infinity;
    const inLast5Min = unsolicited.filter(
      (p) => now.getTime() - new Date(p.postedAt).getTime() < 5 * 60_000,
    ).length;

    const eligible: Array<{ c: InterventionCandidate; s: number }> = [];
    for (const c of candidates) {
      if (postedKeys.has(c.idempotencyKey)) continue; // hard dedup
      if (state.suppressedKeys.has(c.idempotencyKey) || state.suppressedKeys.has(keyFamily(c.idempotencyKey))) {
        suppressed.push({ candidate: c, reason: "suppressed by feedback" });
        continue;
      }
      if (!this.allowedInMode(state, c)) {
        suppressed.push({ candidate: c, reason: `mode ${state.mode}` });
        continue;
      }
      const first = state.candidateFirstSeen.get(c.idempotencyKey) ?? state.roomIndex;
      state.candidateFirstSeen.set(c.idempotencyKey, first);
      if (state.roomIndex - first > cfg.queueTtlMessages) {
        suppressed.push({ candidate: c, reason: "queue TTL expired" });
        continue;
      }
      const s = score(state, c);
      if (s < cfg.minScore) {
        suppressed.push({ candidate: c, reason: `score ${s.toFixed(2)} < ${cfg.minScore}` });
        continue;
      }
      eligible.push({ c, s });
    }
    eligible.sort((a, b) => b.s - a.s);

    for (const { c } of eligible) {
      if (inLast5Min >= cfg.maxPer5Minutes) {
        suppressed.push({ candidate: c, reason: "rate limit: per 5 minutes" });
        continue;
      }
      if (messagesSinceLast < cfg.minRoomMessagesBetween && c.severity !== "high") {
        suppressed.push({ candidate: c, reason: `rate limit: ${messagesSinceLast} messages since last` });
        continue;
      }
      return { post: merge(c, eligible.map((e) => e.c)), suppressed };
    }
    return { post: null, suppressed };
  }
}

/**
 * §51: a higher-priority candidate absorbs lower-priority ones about the same
 * objects, so the room gets one message instead of several. Absorbed keys are
 * recorded as posted and not raised again.
 */
export function merge(top: InterventionCandidate, others: InterventionCandidate[]): InterventionCandidate {
  const related = new Set(top.relatedObjectIds);
  const absorbed = others.filter(
    (o) =>
      o !== top &&
      o.type !== "command_reply" &&
      o.relatedObjectIds.some((id) => related.has(id)),
  );
  if (absorbed.length === 0) return top;
  return {
    ...top,
    involvedAgentIds: [...new Set([...top.involvedAgentIds, ...absorbed.flatMap((o) => o.involvedAgentIds)])],
    relatedObjectIds: [...new Set([...top.relatedObjectIds, ...absorbed.flatMap((o) => o.relatedObjectIds)])],
    evidenceMessageIds: [...new Set([...top.evidenceMessageIds, ...absorbed.flatMap((o) => o.evidenceMessageIds)])],
    blockedAgents: Math.max(top.blockedAgents, ...absorbed.map((o) => o.blockedAgents)),
    absorbedKeys: [...(top.absorbedKeys ?? []), ...absorbed.map((o) => o.idempotencyKey)],
    text: [top.text, ...absorbed.map((o) => o.text)].join("\n\n—\n\n"),
  };
}
