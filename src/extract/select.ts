// Pick the extractor/confirmer backend from the environment (live and replay CLIs).
//   CHORUS_EXTRACTOR   heuristic | gemini | claude. Default: gemini when
//                      GEMINI_API_KEY is set, otherwise heuristic.
//   LLM_MODEL          model for the chosen LLM backend
//   GEMINI_FALLBACK_MODELS  comma-separated; "" disables fallback

import { ClaudeBackend } from "./claude.ts";
import { GeminiBackend } from "./gemini.ts";
import { LlmConfirmer, LlmExtractor, type LlmBackend, type LlmOptions } from "./llm.ts";

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
): { extractor: LlmExtractor; confirmer: LlmConfirmer; model: string } | null {
  let backend: LlmBackend;
  switch (kind) {
    case "heuristic":
      return null;
    case "claude":
      backend = new ClaudeBackend({ model: env.LLM_MODEL || undefined });
      break;
    case "gemini":
      backend = new GeminiBackend({
        apiKey: env.GEMINI_API_KEY,
        model: env.LLM_MODEL || undefined,
        fallbackModels:
          env.GEMINI_FALLBACK_MODELS === undefined
            ? undefined
            : env.GEMINI_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean),
      });
      break;
  }
  return { extractor: new LlmExtractor(backend, opts), confirmer: new LlmConfirmer(backend, opts), model: backend.model };
}
