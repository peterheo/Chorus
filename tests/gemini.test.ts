import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GeminiBackend, GeminiError, GeminiExtractor, GeminiConfirmer, parseDelay } from "../src/extract/gemini.ts";
import { msToPacificMidnight, RateLimiter } from "../src/extract/ratelimit.ts";
import { ExtractionFailedError, type LlmCall } from "../src/extract/llm.ts";
import { extractorKind, llmComponents } from "../src/extract/select.ts";
import { HeuristicExtractor } from "../src/extract/heuristic.ts";
import { RulesFirstExtractor } from "../src/extract/tiered.ts";
import { emptyPayload } from "../src/schemas/llm.ts";

const ctx = { author: "Alice", recent: [], roster: ["Alice", "Bob"], openObjects: [] };

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status: number; json?: unknown; text?: string };

function fakeFetch(replies: Reply[], sent: Sent[] = []): typeof fetch {
  const queue = [...replies];
  return (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const r = queue.shift();
    if (!r) throw new Error("no more fake replies");
    const text = r.text ?? JSON.stringify(r.json);
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const answer = (value: unknown, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  json: {
    candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40, thoughtsTokenCount: 10 },
    ...extra,
  },
});
const commitment = {
  events: [
    {
      type: "commitment",
      confidence: 0.95,
      target_agents: [],
      references: [],
      payload: { ...emptyPayload, action: "handle pricing", conditional: false },
    },
  ],
};
const overloaded: Reply = { status: 503, json: { error: { code: 503, message: "high demand", status: "UNAVAILABLE" } } };
const noSleep = async () => {};

/** Virtual time: sleeping advances the clock the limiter reads. */
function virtualTime(start = Date.parse("2026-09-25T17:00:00Z")) {
  let t = start;
  const delays: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      delays.push(ms);
      t += ms;
    },
    advance: (ms: number) => void (t += ms),
    delays,
  };
}
const quota = (retryDelay: string, quotaId = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"): Reply => ({
  status: 429,
  json: {
    error: {
      code: 429,
      message: "You exceeded your current quota.\n* Quota exceeded for metric: …",
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
      ],
    },
  },
});

describe("Gemini backend", () => {
  it("sends the schema as responseJsonSchema and parses the reply", async () => {
    const sent: Sent[] = [];
    const calls: LlmCall[] = [];
    const x = new GeminiExtractor({
      apiKey: "test-key",
      fetch: fakeFetch([answer(commitment)], sent),
      onCall: (c) => calls.push(c),
    });
    const events = await x.extract("Leave pricing to me.", ctx);
    assert.equal(events[0]!.type, "commitment");
    assert.equal(events[0]!.payload.action, "handle pricing");

    const req = sent[0]!;
    assert.match(req.url, /\/models\/gemini-3\.8-flash:generateContent$/);
    assert.equal(req.headers["x-goog-api-key"], "test-key");
    assert.equal(req.body.generationConfig.responseMimeType, "application/json");
    assert.equal(req.body.generationConfig.responseJsonSchema.$schema, undefined);
    assert.ok(req.body.generationConfig.responseJsonSchema.properties.events);
    assert.match(req.body.systemInstruction.parts[0].text, /extract interaction events/);
    // room content travels as JSON data in the user turn (§64)
    assert.equal(JSON.parse(req.body.contents[0].parts[0].text).message.text, "Leave pricing to me.");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.parsedOk, true);
    assert.equal(calls[0]!.model, "gemini-3.8-flash");
    assert.equal(calls[0]!.inputTokens, 500);
    assert.equal(calls[0]!.outputTokens, 50); // candidates + thoughts
  });

  it("backs off and retries a 503, then succeeds", async () => {
    const sent: Sent[] = [];
    const time = virtualTime();
    const x = new GeminiExtractor({
      apiKey: "k",
      fallbackModels: [],
      fetch: fakeFetch([overloaded, overloaded, answer(commitment)], sent),
      ...time,
    });
    assert.equal((await x.extract("Leave pricing to me.", ctx))[0]!.type, "commitment");
    assert.equal(sent.length, 3);
    assert.deepEqual(time.delays, [1000, 2000]);
  });

  it("moves to a fallback model while the primary backs off", async () => {
    const sent: Sent[] = [];
    const calls: LlmCall[] = [];
    const x = new GeminiExtractor({
      apiKey: "k",
      fallbackModels: ["gemini-flash-lite-latest"],
      fetch: fakeFetch([overloaded, answer(commitment, { modelVersion: "gemini-3.5-flash-lite" })], sent),
      ...virtualTime(),
      onCall: (c) => calls.push(c),
    });
    await x.extract("Leave pricing to me.", ctx);
    assert.deepEqual(
      sent.map((s) => s.url.match(/models\/(.+):/)![1]),
      ["gemini-3.8-flash", "gemini-flash-lite-latest"],
    );
    // the log names the model that actually answered
    assert.equal(calls[0]!.model, "gemini-3.5-flash-lite");
  });

  it("skips a missing model (404) without retrying it", async () => {
    const sent: Sent[] = [];
    const x = new GeminiExtractor({
      apiKey: "k",
      model: "gemini-retired",
      fallbackModels: ["gemini-3.8-flash"],
      fetch: fakeFetch([{ status: 404, json: { error: { message: "not found" } } }, answer(commitment)], sent),
      sleep: noSleep,
    });
    await x.extract("Leave pricing to me.", ctx);
    assert.equal(sent.length, 2);
  });

  it("throws a bad key or bad request instead of retrying", async () => {
    const sent: Sent[] = [];
    const x = new GeminiExtractor({
      apiKey: "bad",
      fetch: fakeFetch([{ status: 400, json: { error: { message: "API key not valid" } } }], sent),
      sleep: noSleep,
    });
    await assert.rejects(x.extract("hi", ctx), (err: unknown) => {
      assert.ok(err instanceof GeminiError);
      assert.equal(err.fatal, true);
      assert.match(err.message, /API key not valid/);
      return true;
    });
    assert.equal(sent.length, 1);
  });

  it("treats a safety block as a refusal: no events", async () => {
    const calls: LlmCall[] = [];
    const x = new GeminiExtractor({
      apiKey: "k",
      fetch: fakeFetch([{ status: 200, json: { candidates: [{ finishReason: "SAFETY" }] } }]),
      onCall: (c) => calls.push(c),
    });
    assert.deepEqual(await x.extract("hi", ctx), []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.parsedOk, false);
  });

  it("retries once on output that fails the schema, then fails extraction", async () => {
    const sent: Sent[] = [];
    const calls: LlmCall[] = [];
    const bad = answer({ events: [{ type: "gossip" }] });
    const x = new GeminiExtractor({ apiKey: "k", fetch: fakeFetch([bad, bad], sent), onCall: (c) => calls.push(c) });
    await assert.rejects(x.extract("hi", ctx), ExtractionFailedError);
    assert.deepEqual(calls.map((c) => c.parsedOk), [false, false]);
    // the retry tells the model what was wrong
    assert.match(sent[1]!.body.contents[0].parts[0].text, /failed validation: schema: events\.0\.type/);
  });

  it("recovers when the retry returns valid JSON", async () => {
    const x = new GeminiExtractor({ apiKey: "k", fetch: fakeFetch([{ status: 200, text: "{not json" }, answer(commitment)]) });
    // a 200 with a non-JSON body is a transport error, retried by the outer loop
    assert.equal((await x.extract("hi", ctx))[0]!.type, "commitment");
  });

  it("ignores thought parts", async () => {
    const reply: Reply = {
      status: 200,
      json: {
        candidates: [
          { content: { parts: [{ text: "thinking…", thought: true }, { text: JSON.stringify(commitment) }] }, finishReason: "STOP" },
        ],
      },
    };
    const x = new GeminiExtractor({ apiKey: "k", fetch: fakeFetch([reply]) });
    assert.equal((await x.extract("hi", ctx)).length, 1);
  });

  it("confirms duplicates and caches the verdict", async () => {
    const sent: Sent[] = [];
    const c = new GeminiConfirmer({ apiKey: "k", fetch: fakeFetch([answer({ verdict: "same", confidence: 0.9 })], sent) });
    assert.equal((await c.duplicate("check pricing", "look into pricing")).verdict, "same");
    assert.equal((await c.duplicate("check pricing", "look into pricing")).verdict, "same");
    assert.equal(sent.length, 1);
  });

  it("paces requests to the per-minute limit", async () => {
    const sent: Sent[] = [];
    const time = virtualTime();
    const x = new GeminiExtractor({
      apiKey: "k",
      fallbackModels: [],
      limits: { rpm: 2 },
      maxWaitMs: 60_000,
      fetch: fakeFetch([answer(commitment), answer(commitment), answer(commitment)], sent),
      ...time,
    });
    for (let i = 0; i < 3; i++) await x.extract("Leave pricing to me.", ctx);
    assert.equal(sent.length, 3);
    // the third request waited for the first to leave the one-minute window
    assert.deepEqual(time.delays, [60_000]);
  });

  it("fails fast without a request when every model is limited past maxWait", async () => {
    const sent: Sent[] = [];
    const calls: LlmCall[] = [];
    const x = new GeminiExtractor({
      apiKey: "k",
      fallbackModels: [],
      limits: { rpm: 1 },
      fetch: fakeFetch([answer(commitment)], sent),
      ...virtualTime(),
      onCall: (c) => calls.push(c),
    });
    await x.extract("Leave pricing to me.", ctx);
    assert.equal(x.available(), false);
    await assert.rejects(x.extract("Leave pricing to me.", ctx), (err: unknown) => {
      assert.ok(err instanceof ExtractionFailedError);
      assert.equal(err.rateLimited, true);
      return true;
    });
    assert.equal(sent.length, 1);
    assert.equal(calls.length, 1); // no retry, no second request
  });

  it("honours a 429's retry delay and uses the fallback model meanwhile", async () => {
    const sent: Sent[] = [];
    const time = virtualTime();
    const x = new GeminiExtractor({
      apiKey: "k",
      fallbackModels: ["gemini-flash-lite-latest"],
      fetch: fakeFetch([quota("43s"), answer(commitment), answer(commitment), answer(commitment)], sent),
      ...time,
    });
    const model = () => sent.at(-1)!.url.match(/models\/(.+):/)![1];
    await x.extract("a", ctx);
    assert.equal(model(), "gemini-flash-lite-latest");
    time.advance(30_000);
    await x.extract("b", ctx);
    assert.equal(model(), "gemini-flash-lite-latest"); // primary still cooling down
    time.advance(14_000);
    await x.extract("c", ctx);
    assert.equal(model(), "gemini-3.8-flash");
    assert.deepEqual(time.delays, []);
  });

  it("treats an alias and the model it serves as one quota", async () => {
    const sent: Sent[] = [];
    const x = new GeminiExtractor({
      apiKey: "k",
      model: "gemini-flash-latest",
      fallbackModels: ["gemini-3.8-flash"],
      limits: { rpm: 1 },
      fetch: fakeFetch([answer(commitment, { modelVersion: "gemini-3.8-flash" }), answer(commitment)], sent),
      ...virtualTime(),
    });
    await x.extract("a", ctx);
    // "gemini-3.8-flash" is the same quota, so nothing is left this minute
    assert.equal(x.available(), false);
    assert.equal(sent.length, 1);
  });

  it("sets a model aside until midnight Pacific when its daily quota is spent", async () => {
    const time = virtualTime(Date.parse("2026-09-25T17:00:00Z")); // 10:00 PDT
    const x = new GeminiExtractor({
      apiKey: "k",
      fallbackModels: [],
      fetch: fakeFetch([quota("20s", "GenerateRequestsPerDayPerProjectPerModel-FreeTier"), answer(commitment)]),
      ...time,
    });
    await assert.rejects(x.extract("a", ctx), (err: unknown) => (err as ExtractionFailedError).rateLimited);
    time.advance(13 * 3600_000 + 59 * 60_000); // 23:59 PDT
    assert.equal(x.available(), false);
    time.advance(60_000); // midnight PDT
    assert.equal(x.available(), true);
    assert.equal((await x.extract("b", ctx)).length, 1);
  });

  it("confirms with the rule-based fallback while rate-limited, without caching it", async () => {
    const sent: Sent[] = [];
    const time = virtualTime();
    const c = new GeminiConfirmer({
      apiKey: "k",
      fallbackModels: [],
      limits: { rpm: 1 },
      fetch: fakeFetch([answer({ verdict: "different", confidence: 0.9 }), answer({ verdict: "same", confidence: 0.9 })], sent),
      ...time,
    });
    await c.duplicate("draft intro", "write summary");
    // limited now: the rule-based confirmer answers (lexical overlap says "same")
    assert.equal((await c.duplicate("check pricing", "look into pricing")).verdict, "same");
    assert.equal(sent.length, 1);
    time.advance(60_000);
    await c.duplicate("check pricing", "look into pricing");
    assert.equal(sent.length, 2); // asked the model once it could
  });

  it("needs an API key", () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      assert.throws(() => new GeminiBackend(), /GEMINI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });
});

describe("extractor selection", () => {
  it("defaults to gemini when a key is set, else heuristic", () => {
    assert.equal(extractorKind({}), "heuristic");
    assert.equal(extractorKind({ GEMINI_API_KEY: "k" }), "gemini");
    assert.equal(extractorKind({ GEMINI_API_KEY: "k", CHORUS_EXTRACTOR: "heuristic" }), "heuristic");
    assert.equal(extractorKind({ CHORUS_EXTRACTOR: "claude" }), "claude");
    assert.throws(() => extractorKind({ CHORUS_EXTRACTOR: "gpt" }), /heuristic, gemini or claude/);
  });

  it("builds a gemini extractor and confirmer from the environment", () => {
    const llm = llmComponents("gemini", { GEMINI_API_KEY: "k", LLM_MODEL: "gemini-3.7-flash" });
    assert.equal(llm!.model, "gemini-3.7-flash");
    assert.equal(llm!.extractor.name, "gemini");
    assert.equal(llmComponents("heuristic", {}), null);
  });
});

describe("rate limiter", () => {
  it("counts requests, input tokens and days per model", () => {
    let t = Date.parse("2026-09-25T17:00:00Z");
    const r = new RateLimiter({ rpm: 2, tpm: 1000, rpd: 3 }, () => t);
    r.take("m", 100);
    r.take("m", 100);
    assert.equal(r.wait("other", 100), 0); // quotas are per model
    assert.equal(r.wait("m", 100), 60_000); // rpm
    t += 60_000;
    assert.equal(r.wait("m", 100), 0);
    r.take("m", 100).settle(950); // the actual count replaces the estimate
    t += 1;
    assert.equal(r.wait("m", 100), msToPacificMidnight(t)); // rpd 3 reached
  });

  it("refunds a request the API rejected", () => {
    const r = new RateLimiter({ rpm: 1, rpd: 1 }, () => 0);
    r.take("m", 100).refund();
    assert.equal(r.wait("m", 100), 0);
    assert.equal(r.usedToday("m"), 0);
  });

  it("waits for token budget to expire", () => {
    let t = 0;
    const r = new RateLimiter({ tpm: 1000 }, () => t);
    r.take("m", 800);
    t += 10_000;
    assert.equal(r.wait("m", 300), 50_000);
    assert.equal(r.wait("m", 200), 0);
  });

  it("computes the time to midnight Pacific", () => {
    assert.equal(msToPacificMidnight(Date.parse("2026-09-25T17:00:00Z")), 14 * 3600_000); // 10:00 PDT
    assert.equal(msToPacificMidnight(Date.parse("2026-12-01T07:30:00Z")), 30 * 60_000); // 23:30 PST
  });

  it("parses retry delays", () => {
    assert.equal(parseDelay("43s"), 43_000);
    assert.equal(parseDelay("1.5s"), 1500);
    assert.equal(parseDelay("30"), 30_000);
    assert.equal(parseDelay("soon"), undefined);
  });
});

describe("rules first", () => {
  it("sends only messages the rules find nothing in to the LLM", async () => {
    const sent: Sent[] = [];
    const x = new RulesFirstExtractor(
      new HeuristicExtractor(),
      new GeminiExtractor({ apiKey: "k", fetch: fakeFetch([answer(commitment)], sent) }),
    );
    assert.equal((await x.extract("I'll check the refund policy.", ctx))[0]!.type, "commitment");
    assert.equal(sent.length, 0);
    assert.equal((await x.extract("Leave pricing to me.", ctx))[0]!.payload.action, "handle pricing");
    assert.equal(sent.length, 1);
    assert.equal(x.savedCalls, 1);
  });

  it("batches only the messages the rules can't read", async () => {
    const sent: Sent[] = [];
    const batch = { results: [{ index: 0, events: commitment.events }] };
    const x = new RulesFirstExtractor(
      new HeuristicExtractor(),
      new GeminiExtractor({ apiKey: "k", fetch: fakeFetch([answer(batch)], sent) }),
    );
    const out = await x.extractBatch([
      { text: "I'll check the refund policy.", ctx },
      { text: "Leave pricing to me.", ctx },
    ]);
    assert.equal(out[0]![0]!.payload.action, "check the refund policy");
    assert.equal(out[1]![0]!.payload.action, "handle pricing");
    assert.equal(JSON.parse(sent[0]!.body.contents[0].parts[0].text).messages.length, 1);
  });

  it("is selected by CHORUS_RULES_FIRST", () => {
    const llm = llmComponents("gemini", { GEMINI_API_KEY: "k", CHORUS_RULES_FIRST: "1" });
    assert.ok(llm!.extractor instanceof RulesFirstExtractor);
  });
});
