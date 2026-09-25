import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GeminiBackend, GeminiError, GeminiExtractor, GeminiConfirmer } from "../src/extract/gemini.ts";
import { ExtractionFailedError, type LlmCall } from "../src/extract/llm.ts";
import { extractorKind, llmComponents } from "../src/extract/select.ts";
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
    modelVersion: "gemini-3.8-flash",
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
    const delays: number[] = [];
    const x = new GeminiExtractor({
      apiKey: "k",
      fetch: fakeFetch([overloaded, overloaded, answer(commitment)], sent),
      sleep: async (ms) => void delays.push(ms),
    });
    assert.equal((await x.extract("Leave pricing to me.", ctx))[0]!.type, "commitment");
    assert.equal(sent.length, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });

  it("falls back to the next model when the primary stays overloaded", async () => {
    const sent: Sent[] = [];
    const calls: LlmCall[] = [];
    const x = new GeminiExtractor({
      apiKey: "k",
      retries: 1,
      fallbackModels: ["gemini-flash-lite-latest"],
      fetch: fakeFetch([overloaded, overloaded, answer(commitment, { modelVersion: "gemini-3.5-flash-lite" })], sent),
      sleep: noSleep,
      onCall: (c) => calls.push(c),
    });
    await x.extract("Leave pricing to me.", ctx);
    assert.deepEqual(
      sent.map((s) => s.url.match(/models\/(.+):/)![1]),
      ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-flash-lite-latest"],
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
