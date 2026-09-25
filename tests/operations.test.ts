// Spec §54 receipts, §43 operations, §59 metrics, §48 LLM call logging,
// §63 LLM budget, §65 retention — and the Claude extractor path with a fake client.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { createApiServer } from "../src/api/server.ts";
import { ChorusRoom } from "../src/chorus.ts";
import { VirtualClock } from "../src/clock.ts";
import { defaultConfig, type ChorusConfig } from "../src/config.ts";
import { HeuristicConfirmer } from "../src/confirm.ts";
import { ClaudeExtractor, ExtractionFailedError, type LlmCall } from "../src/extract/claude.ts";
import { HeuristicExtractor } from "../src/extract/heuristic.ts";
import type { Extractor } from "../src/extract/types.ts";
import { metrics } from "../src/metrics.ts";
import { canonicalJson, ReceiptSigner, verifyReceipt, type SignedReceipt } from "../src/receipts.ts";
import { replay } from "../src/replay.ts";
import { RoomState } from "../src/state/room.ts";
import { ReplayTransport } from "../src/transport/replay.ts";

const agents = [
  { id: "A", display_name: "Alice" },
  { id: "B", display_name: "Bob" },
  { id: "C", display_name: "Cara" },
];
type Msg = { t?: string; agent: string; text: string };
const fixture = (messages: Msg[], extra: Record<string, unknown> = {}) => ({
  room: "ops",
  mode: "assist",
  agents,
  messages,
  ...extra,
});

/** Pull the receipt JSON body out of a posted receipt message. */
function receiptFrom(text: string): SignedReceipt {
  const lines = text.split("\n");
  const sha256 = lines.find((l) => l.startsWith("sha256: "))!.slice(8);
  const signature = lines.find((l) => l.startsWith("signature (Ed25519, base64url): "))!.split(": ")[1]!;
  const body = JSON.parse(lines.at(-1)!);
  return { body, sha256, signature, key_id: body.key_id };
}

describe("receipts (§54)", () => {
  it("canonicalizes per RFC 8785", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1.5, y: -0 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":1.5}}');
    assert.equal(canonicalJson({ "é": 1, e: 2 }), '{"e":2,"é":1}');
  });

  it("signs and verifies; tampering breaks verification", () => {
    const signer = ReceiptSigner.load({});
    const r = signer.sign({ chorus_operation: "facilitation_snapshot", open_questions: ["Q1"] });
    assert.equal(verifyReceipt(r, signer.publicKeyPem), true);
    const tampered = { ...r, body: { ...r.body, open_questions: [] } };
    assert.equal(verifyReceipt(tampered, signer.publicKeyPem), false);
    const other = ReceiptSigner.load({});
    assert.equal(verifyReceipt(r, other.publicKeyPem), false);
  });

  it("@chorus receipt posts a verifiable snapshot of open obligations", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Does the API support refunds?" },
        { agent: "B", text: "I'll verify the refund endpoint." },
        { agent: "C", text: "@chorus receipt" },
      ]),
    );
    const text = r.posted.at(-1)!.text;
    assert.match(text, /^Still open: questions Q1; commitments C1\./);
    const receipt = receiptFrom(text);
    assert.equal(receipt.body.chorus_operation, "facilitation_snapshot");
    assert.deepEqual(receipt.body.open_questions, ["Q1"]);
    assert.equal(verifyReceipt(receipt, r.room.signer.publicKeyPem), true);
    assert.equal(r.room.state.receipts.length, 1);
  });
});

describe("operations (§43)", () => {
  it("@chorus watch switches to facilitate, then reverts with a signed session receipt", async () => {
    const r = await replay(
      fixture(
        [
          { t: "+0s", agent: "A", text: "@chorus watch 5" },
          { t: "+10s", agent: "A", text: "I'll check the pricing." },
          { t: "+20s", agent: "B", text: "I'll investigate the pricing." },
        ],
        { advance_clock_to: "+330s" },
      ),
    );
    assert.deepEqual(
      r.posted.map((p) => p.type),
      ["reply", "duplicate_work", "reply"],
    );
    assert.match(r.posted[0]!.text, /^Watching this room for 5 minutes/);
    const end = r.posted[2]!.text;
    assert.match(end, /^Watch ended\. Chorus posted 1 intervention; mode is back to assist\./);
    const receipt = receiptFrom(end);
    assert.equal(receipt.body.chorus_operation, "watch_session");
    assert.deepEqual((receipt.body.interventions as Array<{ type: string }>).map((i) => i.type), ["duplicate_work"]);
    assert.equal(verifyReceipt(receipt, r.room.signer.publicKeyPem), true);
    assert.equal(r.room.state.mode, "assist");
    assert.equal(r.room.state.session, null);
  });

  it("@chorus facilitate runs until @chorus stop", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "@chorus facilitate" },
        { agent: "A", text: "@chorus facilitate" },
        { agent: "A", text: "@chorus stop" },
        { agent: "A", text: "@chorus stop" },
      ]),
    );
    const texts = r.posted.map((p) => p.text);
    assert.match(texts[0]!, /^Facilitating this room until "@chorus stop"/);
    assert.match(texts[1]!, /already running/);
    assert.match(texts[2]!, /^Facilitation stopped\./);
    assert.match(texts[3]!, /^No watch or facilitation session is running\./);
    assert.equal(r.room.state.mode, "assist");
  });

  it("@chorus replay posts a signed post-room analysis", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Does the API support refunds?" },
        { agent: "B", text: "Yes. Refunds are supported." },
        { agent: "C", text: "@chorus replay" },
      ]),
    );
    const text = r.posted.at(-1)!.text;
    assert.match(text, /^Post-room analysis: 1\/1 questions answered/);
    const receipt = receiptFrom(text);
    assert.equal(receipt.body.chorus_operation, "post_room_analysis");
    assert.equal(verifyReceipt(receipt, r.room.signer.publicKeyPem), true);
  });

  it("can be disabled by config", async () => {
    const config: ChorusConfig = { ...defaultConfig, operations: { enabled: false } };
    const r = await replay(fixture([{ agent: "A", text: "@chorus watch" }]), { config });
    assert.match(r.posted[0]!.text, /not enabled/);
  });
});

describe("metrics (§59)", () => {
  it("counts an acted-on intervention as useful and an ignored one as not", async () => {
    const filler = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ t: `+${from + i * 5}s`, agent: "C", text: `Layout step ${i + 1} filed.` }));
    const r = await replay(
      fixture(
        [
          { t: "+0s", agent: "A", text: "I'll check the pricing." },
          { t: "+5s", agent: "B", text: "I'll investigate the pricing." },
          { t: "+10s", agent: "B", text: "Alice has it, I'll drop mine." }, // acts on the duplicate warning
          { t: "+15s", agent: "A", text: "Does the API support refunds?" },
          ...filler(24, 20), // never answered: the unanswered reminder is ignored
        ],
        { mode: "facilitate" },
      ),
    );
    const m = metrics(r.room.state);
    assert.equal(m.interventions_by_type.duplicate_work, 1);
    assert.equal(m.interventions_by_type.unanswered_question, 1);
    assert.equal(m.duplicates_confirmed, 1);
    assert.equal(m.interventions_followed, 1);
    assert.equal(m.interventions_ignored, 1);
    assert.equal(m.useful_ratio, 0.5);
  });

  it("records @chorus wrong as false-positive feedback", async () => {
    const r = await replay(
      fixture(
        [
          { agent: "A", text: "I'll check the pricing." },
          { agent: "B", text: "I'll investigate the pricing." },
          { agent: "B", text: "@chorus wrong" },
          { agent: "B", text: "@chorus metrics" },
        ],
        { mode: "facilitate" },
      ),
    );
    assert.equal(metrics(r.room.state).false_positive_feedback, 1);
    assert.match(r.posted.at(-1)!.text, /marked wrong: 1/);
  });
});

describe("retention (§65)", () => {
  it("drops the text of old messages but keeps them citable", () => {
    const s = new RoomState("assist");
    s.messages.push(
      { id: "m1", seq: 1, roomIndex: 1, authorId: "A", text: "old", timestamp: "2026-01-01T00:00:00.000Z", isFromChorus: false },
      { id: "m2", seq: 2, roomIndex: 2, authorId: "A", text: "new", timestamp: "2026-01-09T00:00:00.000Z", isFromChorus: false },
    );
    assert.equal(s.prune("2026-01-02T00:00:00.000Z"), 1);
    assert.deepEqual(s.messages.map((m) => m.text), ["", "new"]);
    assert.equal(s.cite("m1"), "#1");
  });
});

/** A stand-in for the Anthropic client: returns queued responses from beta.messages.parse. */
function fakeClient(responses: Array<Record<string, unknown>>): Anthropic {
  const queue = [...responses];
  return {
    beta: {
      messages: {
        parse: async () => {
          const next = queue.shift();
          if (!next) throw new Error("no more fake responses");
          return next;
        },
      },
    },
  } as unknown as Anthropic;
}

const ok = (events: unknown[]) => ({
  content: [{ type: "text", text: JSON.stringify({ events }) }],
  stop_reason: "end_turn",
  stop_details: null,
  parsed_output: { events },
  usage: { input_tokens: 120, output_tokens: 30 },
});
const bad = { content: [{ type: "text", text: "{" }], stop_reason: "max_tokens", stop_details: null, parsed_output: null, usage: { input_tokens: 100, output_tokens: 8000 } };
const refused = { content: [], stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null, usage: { input_tokens: 90, output_tokens: 0 } };
const payload = { text: null, action: "verify the endpoint", conditional: false, deadline: null, subject: null, predicate: null, polarity: null, conditions: null, hedged: null };

describe("Claude extractor (fake client)", () => {
  const ctx = { author: "A", recent: [], roster: ["A"], openObjects: [] };

  it("returns parsed events and reports the call", async () => {
    const calls: LlmCall[] = [];
    const x = new ClaudeExtractor({
      client: fakeClient([ok([{ type: "commitment", confidence: 0.95, target_agents: [], references: [], payload }])]),
      onCall: (c) => calls.push(c),
    });
    const events = await x.extract("I'll verify the endpoint.", ctx);
    assert.equal(events[0]!.type, "commitment");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.parsedOk, true);
    assert.equal(calls[0]!.model, "claude-opus-5");
    assert.equal(calls[0]!.inputTokens, 120);
    assert.match(calls[0]!.rawResponse, /commitment/);
  });

  it("retries once, then throws ExtractionFailedError", async () => {
    const calls: LlmCall[] = [];
    const x = new ClaudeExtractor({ client: fakeClient([bad, bad]), onCall: (c) => calls.push(c) });
    await assert.rejects(x.extract("hello", ctx), ExtractionFailedError);
    assert.deepEqual(calls.map((c) => c.parsedOk), [false, false]);
  });

  it("recovers on the retry", async () => {
    const x = new ClaudeExtractor({ client: fakeClient([bad, ok([])]) });
    assert.deepEqual(await x.extract("hello", ctx), []);
  });

  it("treats a refusal as no events, not a failure", async () => {
    const x = new ClaudeExtractor({ client: fakeClient([refused]) });
    assert.deepEqual(await x.extract("hello", ctx), []);
  });
});

describe("pipeline with an LLM extractor", () => {
  function build(extractor: Extractor, config: ChorusConfig) {
    const clock = new VirtualClock();
    const transport = new ReplayTransport([{ id: "A", name: "Alice" }], () => clock.now());
    const room = new ChorusRoom({
      transport,
      extractor,
      fallbackExtractor: new HeuristicExtractor(),
      confirmer: new HeuristicConfirmer(),
      clock,
      config,
    });
    return { room, transport, clock };
  }

  it("counts extraction failures and keeps going", async () => {
    const { room, transport } = build(new ClaudeExtractor({ client: fakeClient([bad, bad]) }), defaultConfig);
    await room.start();
    await transport.deliver("A", "I'll verify the endpoint.");
    await room.idle();
    assert.equal(room.state.counters.get("extraction_failures"), 1);
    assert.equal(room.state.commitments.size, 0);
  });

  it("falls back to the rule-based extractor over the per-minute budget (§63)", async () => {
    const commitment = ok([{ type: "commitment", confidence: 0.95, target_agents: [], references: [], payload }]);
    const x = new ClaudeExtractor({ client: fakeClient([commitment, commitment]) });
    const { room, transport } = build(x, { ...defaultConfig, llm: { maxCallsPerMinute: 2 } });
    await room.start();
    for (const text of ["I'll verify the endpoint.", "I'll verify the endpoint again.", "I'll draft the summary."]) {
      await transport.deliver("A", text);
      await room.idle();
    }
    assert.equal(room.state.counters.get("llm_budget_fallbacks"), 1);
    // The third message went through the rule-based extractor.
    assert.equal(room.state.commitments.get("C3")!.action, "draft the summary");
  });
});

describe("API: keys, metrics, receipts", () => {
  it("serves the public key without auth, and metrics/receipts with it", async () => {
    const r = await replay(fixture([{ agent: "A", text: "@chorus receipt" }]));
    const server = createApiServer({ rooms: new Map([["rom_x", r.room]]), token: "t" });
    await new Promise<void>((ok) => server.listen(0, ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const key = (await (await fetch(`${base}/v1/keys/${r.room.signer.keyId}`)).json()) as { public_key_pem: string };
      const receipt = receiptFrom(r.posted[0]!.text);
      assert.equal(verifyReceipt(receipt, key.public_key_pem), true);
      assert.equal((await fetch(`${base}/v1/keys/nope`)).status, 404);
      const auth = { headers: { authorization: "Bearer t" } };
      const m = (await (await fetch(`${base}/v1/rooms/rom_x/metrics`, auth)).json()) as { command_replies: number };
      assert.equal(m.command_replies, 1);
      const rs = (await (await fetch(`${base}/v1/rooms/rom_x/receipts`, auth)).json()) as { receipts: unknown[] };
      assert.equal(rs.receipts.length, 1);
      assert.equal((await fetch(`${base}/v1/rooms/rom_x/metrics`)).status, 401);
    } finally {
      server.close();
    }
  });
});
