// Every tunable from spec §72. Similarity thresholds are tied to the
// similarity backend (lexical in the hackathon profile, see similarity.ts).

export type Mode = "observe" | "assist" | "facilitate";

export interface ChorusConfig {
  mode: Mode;
  tickSeconds: number;
  thresholds: {
    extractionAutoApply: number;
    extractionCorroborated: number;
    extractionCandidate: number;
    answerRelevance: number;
    duplicateCandidate: number;
    duplicateConfirm: number;
    conflictSubject: number;
    conflictConfidence: number;
    stale: number;
  };
  interventions: {
    minScore: number;
    maxPer5Minutes: number;
    minRoomMessagesBetween: number;
    queueTtlMessages: number;
    cooldownMessages: number;
  };
  unanswered: {
    minSubsequentMessages: number;
    maxWaitSeconds: number;
    minSeconds: number;
    resurfaceCooldownMessages: number;
  };
  handoff: { minTargetMessages: number; resurfaceCooldownMessages: number };
  stale: { ageRefSeconds: number; roomRefMessages: number; resurfaceCooldownMessages: number };
  presence: { activeWindowMessages: number };
  extraction: { recentWindow: number };
}

export const defaultConfig: ChorusConfig = {
  mode: "assist",
  tickSeconds: 15,
  thresholds: {
    extractionAutoApply: 0.9,
    extractionCorroborated: 0.75,
    extractionCandidate: 0.55,
    answerRelevance: 0.8,
    duplicateCandidate: 0.75,
    duplicateConfirm: 0.85,
    conflictSubject: 0.85,
    conflictConfidence: 0.9,
    stale: 0.7,
  },
  interventions: {
    minScore: 0.55,
    maxPer5Minutes: 3,
    minRoomMessagesBetween: 8,
    queueTtlMessages: 16,
    cooldownMessages: 20,
  },
  unanswered: {
    minSubsequentMessages: 12,
    maxWaitSeconds: 300,
    minSeconds: 30,
    resurfaceCooldownMessages: 20,
  },
  handoff: { minTargetMessages: 3, resurfaceCooldownMessages: 20 },
  stale: { ageRefSeconds: 600, roomRefMessages: 30, resurfaceCooldownMessages: 30 },
  presence: { activeWindowMessages: 30 },
  extraction: { recentWindow: 10 },
};

export function withMode(config: ChorusConfig, mode: Mode): ChorusConfig {
  return { ...config, mode };
}
