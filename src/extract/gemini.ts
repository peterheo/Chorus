// Gemini backend (Google AI Studio / Generative Language API) for the LLM
// extractor and confirmer (llm.ts). Plain REST: the Zod schema is sent as
// `responseJsonSchema` and the JSON reply is validated with the same schema.
// Requests are paced by a client-side rate limiter (per-model RPM, TPM, RPD,
// as Google counts them). A 429 puts the model on the cooldown it asks for (a
// daily quota: until midnight Pacific); a 503 backs off. Either way the next
// fallback model, which has its own quota, is tried. When every model is
// limited for longer than `maxWaitMs`, the request fails fast with
// RateLimitedError and Chorus uses its rule-based extractor instead.

import { z } from "zod";
import { HeuristicConfirmer } from "../confirm.ts";
import {
  LlmConfirmer,
  LlmExtractor,
  RateLimitedError,
  type BackendResult,
  type LlmBackend,
  type LlmOptions,
  type Usage,
} from "./llm.ts";
import { msToPacificMidnight, RateLimiter, type RateLimits } from "./ratelimit.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
/** A different model, so a different quota ("gemini-flash-latest" is the primary under another name). */
export const DEFAULT_GEMINI_FALLBACKS = ["gemini-flash-lite-latest"];
/**
 * Per model, conservative free-tier values; set yours from https://ai.dev/rate-limit.
 * No daily cap by default: the 429 for a spent daily quota sets the model aside
 * until midnight Pacific, so the whole quota gets used whatever its size.
 */
export const DEFAULT_GEMINI_LIMITS: RateLimits = { rpm: 5, tpm: 250_000 };
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
  /** per-model quota to stay under (default DEFAULT_GEMINI_LIMITS) */
  limits?: RateLimits;
  /** share one limiter between backends using the same key */
  limiter?: RateLimiter;
  /** longest a request waits for quota before failing fast (default 15 s) */
  maxWaitMs?: number;
  now?: () => number;
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

  /** 429: how long the quota asks us to wait */
  retryAfterMs?: number;
  /** 429: a daily quota is spent */
  daily = false;
  /** 429: the model whose quota was hit (may differ from the requested alias) */
  quotaModel?: string;
}

interface ErrorDetail {
  "@type"?: string;
  retryDelay?: string;
  violations?: Array<{ quotaId?: string; quotaMetric?: string; quotaDimensions?: { model?: string } }>;
}

/** "43s" / "1.5s" (google.rpc.RetryInfo) or "43" (Retry-After) → ms. */
export function parseDelay(d: string | undefined): number | undefined {
  const m = d?.match(/^(\d+(?:\.\d+)?)s?$/);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
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
    this.limiter = opts.limiter ?? new RateLimiter(opts.limits ?? DEFAULT_GEMINI_LIMITS, opts.now);
  }

  readonly limiter: RateLimiter;

  private get maxWaitMs(): number {
    return this.opts.maxWaitMs ?? 15_000;
  }

  /** The soonest any model can take a request of about `tokens` input tokens. */
  private soonest(tokens: number, skip: ReadonlySet<string> = new Set()): { model: string; wait: number } | null {
    let best: { model: string; wait: number } | null = null;
    for (const model of this.models) {
      if (skip.has(model)) continue;
      const wait = this.limiter.wait(this.quotaKey(model), tokens);
      if (!best || wait < best.wait) best = { model, wait };
      if (wait === 0) break; // models are in preference order
    }
    return best;
  }

  available(): boolean {
    const s = this.soonest(1000);
    return s !== null && s.wait <= this.maxWaitMs;
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
    // Google counts input tokens; about four characters per token.
    const estimate = Math.ceil((req.system.length + req.content.length) / 4);
    const failures = new Map<string, number>();
    const done = new Set<string>(); // models given up on for this request
    let last: GeminiError | null = null;
    for (;;) {
      const next = this.soonest(estimate, done);
      if (!next) throw last ?? new GeminiError("no Gemini model available", null, false);
      if (next.wait > this.maxWaitMs) {
        throw new RateLimitedError(
          `all Gemini models rate-limited for ${Math.ceil(next.wait / 1000)} s${last ? ` (last error: ${last.message})` : ""}`,
          next.wait,
        );
      }
      if (next.wait > 0) await this.sleep(next.wait);
      const { model } = next;
      const slot = this.limiter.take(this.quotaKey(model), estimate);
      try {
        const response = await this.post(model, body);
        slot.settle(response.usageMetadata?.promptTokenCount ?? null);
        this.learnAlias(model, response.modelVersion);
        return this.interpret(response, model, req.schema);
      } catch (err) {
        if (!(err instanceof GeminiError)) throw err;
        if (err.fatal) throw err;
        // Rejected, not served: it doesn't use quota.
        if (err.status !== null) slot.refund();
        this.opts.log?.(err.message);
        last = err;
        const n = (failures.get(model) ?? 0) + 1;
        failures.set(model, n);
        if (err.status === 429) {
          // Honour the quota's own retry delay; a spent daily quota lasts until midnight Pacific.
          this.learnAlias(model, err.quotaModel);
          const ms = err.daily ? msToPacificMidnight(this.now()) : (err.retryAfterMs ?? 60_000);
          this.limiter.cooldown(this.quotaKey(model), ms);
          if (n >= 2) done.add(model);
        } else if (err.status === 404 || n > (this.opts.retries ?? 2)) {
          // A missing model won't appear on retry; an overloaded one has had its chances.
          done.add(model);
        } else {
          this.limiter.cooldown(this.quotaKey(model), (this.opts.backoffMs ?? 1000) * 2 ** (n - 1));
        }
      }
    }
  }

  /**
   * Google counts quota per underlying model: "gemini-flash-latest" and the
   * model it points at share one. Learned from the served modelVersion and
   * from a 429's quota dimensions.
   */
  private readonly aliases = new Map<string, string>();

  private quotaKey(model: string): string {
    return this.aliases.get(model) ?? model;
  }

  private learnAlias(requested: string, served: string | undefined): void {
    if (!served || served === requested || this.aliases.get(requested) === served) return;
    this.aliases.set(requested, served);
    this.limiter.merge(requested, served);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
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
    let details: ErrorDetail[] = [];
    try {
      const e = (JSON.parse(text) as { error?: { message?: string; details?: ErrorDetail[] } }).error;
      message = e?.message?.split("\n")[0] ?? message;
      details = e?.details ?? [];
    } catch {
      // not JSON; keep the raw text
    }
    const fatal = !TRANSIENT.has(res.status) && res.status !== 404;
    const err = new GeminiError(`${model}: HTTP ${res.status}: ${message}`, res.status, fatal);
    if (res.status === 429) {
      const delay = details.find((d) => d.retryDelay)?.retryDelay ?? res.headers.get("retry-after") ?? undefined;
      err.retryAfterMs = parseDelay(delay);
      const violations = details.flatMap((d) => d.violations ?? []);
      err.daily = violations.some((v) => /PerDay/.test(v.quotaId ?? ""));
      err.quotaModel = violations.find((v) => v.quotaDimensions?.model)?.quotaDimensions?.model;
    }
    throw err;
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
    super(new GeminiBackend(opts), { ...opts, fallback: new HeuristicConfirmer() });
  }
}
