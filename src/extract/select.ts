// Pick the extractor/confirmer backend from the environment (live and replay CLIs).
//   CHORUS_EXTRACTOR   heuristic | gemini | claude. Default: gemini when
//                      GEMINI_API_KEY is set, otherwise heuristic.
//   LLM_MODEL          model for the chosen LLM backend
//   GEMINI_FALLBACK_MODELS  comma-separated; "" disables fallback
//   GEMINI_RPM / GEMINI_TPM / GEMINI_RPD  your per-model quota (requests/min,
//                      input tokens/min, requests/day); default 10 / 250000 / 250
//   GEMINI_MAX_WAIT_MS longest a message waits for quota before the rules
//                      extractor takes it (default 15000)
//   CHORUS_RULES_FIRST "1": only messages the rules find nothing in go to the LLM

import { HeuristicConfirmer } from "../confirm.ts";
import { ClaudeBackend } from "./claude.ts";
import { DEFAULT_GEMINI_LIMITS, GeminiBackend } from "./gemini.ts";
import { HeuristicExtractor } from "./heuristic.ts";
import { LlmConfirmer, LlmExtractor, type LlmBackend, type LlmOptions } from "./llm.ts";
import { RulesFirstExtractor } from "./tiered.ts";
import type { Extractor } from "./types.ts";

export type ExtractorKind = "heuristic" | "gemini" | "claude";

export function extractorKind(env: NodeJS.ProcessEnv): ExtractorKind {
  const k = env.CHORUS_EXTRACTOR ?? (env.GEMINI_API_KEY ? "gemini" : "heuristic");
  if (k !== "heuristic" && k !== "gemini" && k !== "claude") {
    throw new Error(`CHORUS_EXTRACTOR must be heuristic, gemini or claude (got ${k})`);
  }
  return k;
}

/** The LLM extractor and confirmer for `kind`, sharing one backend; null for heuristic. */
export function llmComponents(
  kind: ExtractorKind,
  env: NodeJS.ProcessEnv,
  opts: LlmOptions = {},
): { extractor: Extractor; confirmer: LlmConfirmer; model: string } | null {
  let backend: LlmBackend;
  switch (kind) {
    case "heuristic":
      return null;
    case "claude":
      backend = new ClaudeBackend({ model: env.LLM_MODEL || undefined });
      break;
    case "gemini":
      backend = new GeminiBackend({
        log: opts.log,
        apiKey: env.GEMINI_API_KEY,
        model: env.LLM_MODEL || undefined,
        fallbackModels:
          env.GEMINI_FALLBACK_MODELS === undefined
            ? undefined
            : env.GEMINI_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean),
        limits: {
          rpm: num(env, "GEMINI_RPM") ?? DEFAULT_GEMINI_LIMITS.rpm,
          tpm: num(env, "GEMINI_TPM") ?? DEFAULT_GEMINI_LIMITS.tpm,
          rpd: num(env, "GEMINI_RPD") ?? DEFAULT_GEMINI_LIMITS.rpd,
        },
        maxWaitMs: num(env, "GEMINI_MAX_WAIT_MS"),
      });
      break;
  }
  return {
    extractor:
      env.CHORUS_RULES_FIRST === "1"
        ? new RulesFirstExtractor(new HeuristicExtractor(), new LlmExtractor(backend, opts))
        : new LlmExtractor(backend, opts),
    confirmer: new LlmConfirmer(backend, { ...opts, fallback: new HeuristicConfirmer() }),
    model: backend.model,
  };
}

function num(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number (got ${v})`);
  return n;
}
