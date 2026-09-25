// Spec §78 stretch features: agent brief, health dimensions, interaction map, topic threads.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentBrief, health, interactionMap, threads } from "../src/insights.ts";
import { replay } from "../src/replay.ts";

const agents = [
  { id: "A", display_name: "Alice" },
  { id: "B", display_name: "Bob" },
  { id: "C", display_name: "Cara" },
];
type Msg = { t?: string; agent: string; text: string; reply_to?: number };
const fixture = (messages: Msg[], extra: Record<string, unknown> = {}) => ({
  room: "insights",
  mode: "facilitate",
  agents,
  messages,
  ...extra,
});
const chatter = (n: number, agent = "C") =>
  Array.from({ length: n }, (_, i) => ({ agent, text: `Layout step ${i + 1} filed.` }));

describe("agent brief", () => {
  it("welcomes back an agent who was away, with what concerns them", async () => {
    const r = await replay(
      fixture([
        { agent: "B", text: "Does the API support refunds?" },
        { agent: "B", text: "I'll draft the summary." },
        { agent: "A", text: "Yes. Refunds are supported.", reply_to: 0 },
        { agent: "A", text: "Bob, check the receipt endpoint." },
        { agent: "A", text: "Decided: the output format is JSON." },
        ...chatter(30),
        { agent: "B", text: "Back now." },
      ]),
    );
    const brief = r.posted.find((p) => p.type === "agent_brief");
    assert.ok(brief, `got ${r.posted.map((p) => p.type).join(", ")}`);
    assert.match(brief.text, /^Welcome back, Bob\. Since you were last active \(33 messages ago\):/);
    assert.match(brief.text, /Q1 "Does the API support refunds\?" → answered \(#3\)/);
    assert.match(brief.text, /Alice handed H1 to you: check the receipt endpoint \(#4\)/);
    assert.match(brief.text, /D1 "the output format is JSON" was created \(#5\)/);
    assert.match(brief.text, /Waiting on you: H1 \(handoff from Alice\)/);
  });

  it("does not brief an agent who was only briefly away", async () => {
    const r = await replay(
      fixture([
        { agent: "B", text: "Does the API support refunds?" },
        { agent: "A", text: "Yes. Refunds are supported.", reply_to: 0 },
        { agent: "B", text: "Thanks, noted." },
      ]),
    );
    assert.ok(!r.posted.some((p) => p.type === "agent_brief"));
  });

  it("@chorus brief works on demand, and the API exposes it", async () => {
    const r = await replay(
      fixture([
        { agent: "B", text: "Does the API support refunds?" },
        { agent: "A", text: "Yes. Refunds are supported.", reply_to: 0 },
        { agent: "B", text: "@chorus brief" },
      ]),
    );
    assert.match(r.posted.at(-1)!.text, /^Since your previous message \(1 messages ago\):/);
    assert.match(r.posted.at(-1)!.text, /Q1 .* → answered/);
    assert.ok(agentBrief(r.room.state, "B", 1, "").length > 0);
  });
});

describe("health, map, threads", () => {
  it("reports health as separate dimensions", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "I'll check the pricing." },
        { agent: "B", text: "I'll investigate the pricing." },
        { agent: "A", text: "Refunds are supported." },
        { agent: "B", text: "Refunds are not supported." },
        { agent: "C", text: "Does the API support streaming?" },
      ]),
    );
    const h = health(r.room.state);
    assert.equal(h.duplicate_work.active_pairs, 1);
    assert.equal(h.unresolved_conflicts.confirmed, 1);
    assert.equal(h.open_obligations.questions, 1);
    assert.equal(h.open_obligations.commitments, 2);
  });

  it("maps who interacts with whom", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Does the API support refunds?" },
        { agent: "B", text: "Yes. Refunds are supported.", reply_to: 0 },
        { agent: "A", text: "Bob, check the receipt endpoint." },
        { agent: "C", text: "I'll write the summary." },
        { agent: "A", text: "Waiting on C1." },
      ]),
    );
    const edges = interactionMap(r.room.state);
    const ab = edges.find((e) => e.from === "A" && e.to === "B")!;
    assert.equal(ab.handoffs, 1);
    assert.equal(edges.find((e) => e.from === "B" && e.to === "A")!.replies, 1);
    assert.equal(edges.find((e) => e.from === "A" && e.to === "C")!.dependencies, 1);
  });

  it("separates simultaneous topics into threads", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Does the API support refunds?" },
        { agent: "B", text: "I'll check refund support." },
        { agent: "C", text: "What font should the report use?" },
        { agent: "A", text: "I'll pick the report font." },
        { agent: "B", text: "Refunds are supported." },
        { agent: "C", text: "@chorus threads" },
      ]),
    );
    const ts = threads(r.room.state);
    const refunds = ts.find((t) => t.objects.includes("Q1"))!;
    const font = ts.find((t) => t.objects.includes("Q2"))!;
    assert.notEqual(refunds, font);
    assert.ok(refunds.objects.includes("C1") && refunds.objects.includes("K1"));
    assert.ok(font.objects.includes("C2"));
    assert.match(r.posted.at(-1)!.text, /^TOPIC THREADS/);
  });
});
