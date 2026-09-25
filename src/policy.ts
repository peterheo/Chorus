// Intervention policy (spec §26, §51, §71): mode filter, score, dedup,
// rate limits, and a TTL for candidates that keep getting rate-limited.

import type { ChorusConfig } from "./config.ts";
import type { RoomState } from "./state/room.ts";
import type { InterventionCandidate } from "./state/types.ts";

const SEVERITY = { low: 0.2, medium: 0.5, high: 1.0 } as const;

export function score(state: RoomState, c: InterventionCandidate): number {
  const recentChorus = state.messages
    .slice(-10)
    .filter((m) => m.isFromChorus).length;
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

export class InterventionPolicy {
  constructor(private readonly config: () => ChorusConfig) {}

  private allowedInMode(state: RoomState, c: InterventionCandidate): boolean {
    switch (state.mode) {
      case "observe":
        return false;
      case "assist":
        // §71: only high-confidence alerts of these types.
        return (
          ["conflict_detected", "repeated_question", "dependency_resolved"].includes(c.type) && c.confidence >= 0.9
        );
      case "facilitate":
        return true;
    }
  }

  choose(state: RoomState, candidates: InterventionCandidate[], now: Date): Decision {
    const cfg = this.config().interventions;
    const suppressed: Decision["suppressed"] = [];
    const postedKeys = new Set(state.posted.map((p) => p.candidate.idempotencyKey));

    const unsolicited = state.posted.filter((p) => !p.solicited);
    const last = unsolicited[unsolicited.length - 1];
    const messagesSinceLast = last ? state.roomIndex - last.postedIndex : Infinity;
    const inLast5Min = unsolicited.filter(
      (p) => now.getTime() - new Date(p.postedAt).getTime() < 5 * 60_000,
    ).length;

    const eligible: Array<{ c: InterventionCandidate; s: number }> = [];
    for (const c of candidates) {
      if (postedKeys.has(c.idempotencyKey)) continue; // hard dedup
      if (state.suppressedKeys.has(c.idempotencyKey)) {
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
      return { post: c, suppressed };
    }
    return { post: null, suppressed };
  }
}
