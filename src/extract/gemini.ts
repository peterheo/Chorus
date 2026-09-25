// Gemini backend (Google AI Studio / Generative Language API) for the LLM
// extractor and confirmer (llm.ts). Plain REST: the Zod schema is sent as
// `responseJsonSchema` and the JSON reply is validated with the same schema.
// Gemini returns 503 under load and 429 on quota, so each request backs off
// and retries, then moves down a list of fallback models.

import { z } from "zod";
import { LlmConfirmer, LlmExtractor, type BackendResult, type LlmBackend, type LlmOptions, type Usage } from "./llm.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_GEMINI_FALLBACKS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Statuses worth retrying: rate limit / quota, and server-side overload or failure. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
/** finishReason values that mean the model declined to answer. */
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

export interface GeminiOptions extends LlmOptions {
  /** defaults to $GEMINI_API_KEY */
  apiKey?: string;
  model?: string;
  /** tried in order when the primary model stays unavailable; [] disables */
  fallbackModels?: string[];
  /** retries per model on a transient error (default 2) */
  retries?: number;
  /** first backoff delay; doubles per retry (default 1000 ms) */
  backoffMs?: number;
  /** per-request timeout (default 60 s) */
  timeoutMs?: number;
  /** Gemini 3 thinking level (default "low"); null leaves it to the model */
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | null;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** retrying cannot help: bad request, bad key, permission */
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
}

const jsonSchemas = new WeakMap<z.ZodType, unknown>();

/** Zod → JSON Schema for `responseJsonSchema` (no `$schema` key). */
export function toGeminiSchema(schema: z.ZodType): unknown {
  let s = jsonSchemas.get(schema);
  if (!s) {
    const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
    s = rest;
    jsonSchemas.set(schema, s);
  }
  return s;
}

export class GeminiBackend implements LlmBackend {
  readonly name = "gemini";
  readonly model: string;
  private readonly models: string[];
  private readonly apiKey: string;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: GeminiOptions = {}) {
    const key = opts.apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Gemini backend needs an API key (GEMINI_API_KEY)");
    this.apiKey = key;
    this.model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.models = [...new Set([this.model, ...(opts.fallbackModels ?? DEFAULT_GEMINI_FALLBACKS)])];
    this.fetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async generate<S extends z.ZodType>(req: {
    system: string;
    content: string;
    schema: S;
  }): Promise<BackendResult<z.infer<S>>> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.content }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiSchema(req.schema),
        maxOutputTokens: 8192,
        ...(this.opts.thinkingLevel === null ? {} : { thinkingConfig: { thinkingLevel: this.opts.thinkingLevel ?? "low" } }),
      },
    });
    let last: GeminiError | null = null;
    for (const model of this.models) {
      const retries = this.opts.retries ?? 2;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await this.sleep((this.opts.backoffMs ?? 1000) * 2 ** (attempt - 1));
        try {
          return this.interpret(await this.post(model, body), model, req.schema);
        } catch (err) {
          if (!(err instanceof GeminiError)) throw err;
          if (err.fatal) throw err;
          last = err;
          // A missing model won't appear on retry: go straight to the next one.
          if (err.status === 404) break;
        }
      }
    }
    throw last ?? new GeminiError("no Gemini model available", null, false);
  }

  isFatal(err: unknown): boolean {
    return err instanceof GeminiError && err.fatal;
  }

  private async post(model: string, body: string): Promise<GeminiResponse> {
    const url = `${this.opts.baseUrl ?? BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
    let res: Response;
    try {
      res = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw new GeminiError(`${model}: ${(err as Error).message}`, null, false);
    }
    if (res.ok) return (await res.json()) as GeminiResponse;
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // not JSON; keep the raw text
    }
    const fatal = !TRANSIENT.has(res.status) && res.status !== 404;
    throw new GeminiError(`${model}: HTTP ${res.status}: ${message}`, res.status, fatal);
  }

  private interpret<S extends z.ZodType>(r: GeminiResponse, requested: string, schema: S): BackendResult<z.infer<S>> {
    const model = r.modelVersion ?? requested;
    const m = r.usageMetadata;
    const usage: Usage = {
      inputTokens: m?.promptTokenCount ?? null,
      outputTokens: m?.candidatesTokenCount != null ? m.candidatesTokenCount + (m.thoughtsTokenCount ?? 0) : null,
    };
    if (r.promptFeedback?.blockReason) {
      return { kind: "refused", detail: r.promptFeedback.blockReason, raw: JSON.stringify(r), model, usage };
    }
    const candidate = r.candidates?.[0];
    if (!candidate) return { kind: "invalid", reason: "no candidates", raw: JSON.stringify(r), model, usage };
    if (candidate.finishReason && BLOCKED.has(candidate.finishReason)) {
      return { kind: "refused", detail: candidate.finishReason, raw: JSON.stringify(r), model, usage };
    }
    const text = (candidate.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
    const raw = text || JSON.stringify(r);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: "invalid", reason: `finishReason=${candidate.finishReason ?? "?"}, output is not JSON`, raw, model, usage };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { kind: "invalid", reason: `schema: ${issue?.path.join(".")} ${issue?.message}`, raw, model, usage };
    }
    return { kind: "parsed", value: parsed.data as z.infer<S>, raw, model, usage };
  }
}

export class GeminiExtractor extends LlmExtractor {
  constructor(opts: GeminiOptions = {}) {
    super(new GeminiBackend(opts), opts);
  }
}

export class GeminiConfirmer extends LlmConfirmer {
  constructor(opts: GeminiOptions = {}) {
    super(new GeminiBackend(opts), opts);
  }
}
