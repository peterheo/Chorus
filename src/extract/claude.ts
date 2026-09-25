// Claude backend for the LLM extractor and confirmer (llm.ts). Structured
// output via a Zod schema; the server falls back to another model when the
// requested one is unavailable.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { LlmConfirmer, LlmExtractor, type BackendResult, type LlmBackend, type LlmOptions } from "./llm.ts";

export const DEFAULT_MODEL = "claude-opus-5";

export interface ClaudeOptions extends LlmOptions {
  model?: string;
  client?: Anthropic;
}

export class ClaudeBackend implements LlmBackend {
  readonly name = "claude";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: ClaudeOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  async generate<S extends z.ZodType>(req: {
    system: string;
    content: string;
    schema: S;
  }): Promise<BackendResult<z.infer<S>>> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(req.schema) },
      system: req.system,
      messages: [{ role: "user", content: req.content }],
    });
    const raw = JSON.stringify(response.content);
    const model = response.model ?? this.model;
    const usage = { inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null };
    if (response.stop_reason === "refusal") {
      return { kind: "refused", detail: response.stop_details?.category ?? "unknown", raw, model, usage };
    }
    if (response.parsed_output != null) {
      return { kind: "parsed", value: response.parsed_output as z.infer<S>, raw, model, usage };
    }
    return { kind: "invalid", reason: `stop_reason=${response.stop_reason}, no parsed output`, raw, model, usage };
  }

  isFatal(err: unknown): boolean {
    return err instanceof Anthropic.BadRequestError || err instanceof Anthropic.AuthenticationError;
  }
}

export class ClaudeExtractor extends LlmExtractor {
  constructor(opts: ClaudeOptions = {}) {
    super(new ClaudeBackend(opts), opts);
  }
}

export class ClaudeConfirmer extends LlmConfirmer {
  constructor(opts: ClaudeOptions = {}) {
    super(new ClaudeBackend(opts), opts);
  }
}
