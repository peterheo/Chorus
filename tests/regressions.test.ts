// Regression tests for findings from the code review of the full branch.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChorusRoom } from "../src/chorus.ts";
import { VirtualClock } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { HeuristicConfirmer } from "../src/confirm.ts";
import { parseDeadline } from "../src/deadline.ts";
import { HeuristicExtractor, mentions } from "../src/extract/heuristic.ts";
import type { Extractor } from "../src/extract/types.ts";
import { replay } from "../src/replay.ts";
import { event } from "../src/schemas/llm.ts";
import { ReplayTransport } from "../src/transport/replay.ts";
import { SharedNetTransport } from "../src/transport/sharednet.ts";
import type { OutboundMessage, SendResult } from "../src/transport/types.ts";

const agents = [
  { id: "A", display_name: "Alice" },
  { id: "B", display_name: "Bob" },
  { id: "C", display_name: "Cara" },
];
type Msg = { t?: string; agent: string; text: string; reply_to?: number };
const fixture = (messages: Msg[], extra: Record<string, unknown> = {}) => ({
  room: "regress",
  mode: "facilitate",
  agents,
  messages,
  ...extra,
});

/** A replay transport whose next `failures` sends throw, like a SharedNet outage. */
class FlakyTransport extends ReplayTransport {
  failures = 0;
  override async sendMessage(out: OutboundMessage): Promise<SendResult> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("SharedNet 503");
    }
    return super.sendMessage(out);
  }
}

function room(transport: ReplayTransport, clock: VirtualClock, extractor: Extractor = new HeuristicExtractor()) {
  return new ChorusRoom({
    transport,
    extractor,
    confirmer: new HeuristicConfirmer(),
    clock,
    config: { ...defaultConfig, mode: "facilitate" },
  });
}

describe("processing failures", () => {
  it("roll back, reject the delivery, and succeed on redelivery without losing the intervention", async () => {
    const clock = new VirtualClock();
    const t = new FlakyTransport([{ id: "A" }, { id: "B" }], () => clock.now());
    const r = room(t, clock);
    await r.start();
    await t.deliver("A", "I'll check the pricing.");
    await r.idle();

    t.failures = 1; // posting the duplicate warning fails
    await assert.rejects(t.deliver("B", "I'll investigate the pricing."), /503/);
    await r.idle();
    assert.equal(r.state.commitments.size, 1, "the failed message left no state behind");
    assert.equal(r.state.posted.length, 0, "a failed send is not recorded as posted");

    await t.redeliver(t.log.find((m) => m.text.includes("investigate"))!);
    await r.idle();
    assert.equal(r.state.commitments.size, 2);
    assert.equal(t.sent.filter((m) => m.text.startsWith("Potential duplicate work")).length, 1);
  });
});

describe("extractor robustness", () => {
  it("agent names with regex characters are matched literally", async () => {
    assert.equal(mentions("waiting on C++Bot's review", "C++Bot"), true);
    assert.equal(mentions("waiting on Cxx", "C.x"), false);
    const x = new HeuristicExtractor();
    const events = await x.extract("Waiting on C++Bot's review.", { author: "A", recent: [], roster: ["C++Bot", "qa(bot"], openObjects: [] });
    assert.deepEqual(events[0]!.target_agents, ["C++Bot"]);
  });

  it("ordinary 'I'm …' sentences are not learned as names", async () => {
    const r = await replay(
      fixture([{ agent: "C", text: "I'm stuck." }, { agent: "C", text: "This is wrong." }, { agent: "C", text: "I'm Cara." }]),
      {},
    );
    assert.deepEqual(r.room.state.agents.get("C")!.aliases, []); // "Cara" is already C's display name
  });

  it("a later clear deadline is found after an ambiguous 'at 3'", () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(parseDeadline("look at 3 endpoints by 14:30", t0)?.deadline, "2026-01-01T14:30:00.000Z");
  });
});

describe("state engine", () => {
  it("@chorus resolved releases agents waiting on the commitment", async () => {
    const r = await replay(
      fixture([
        { agent: "B", text: "I'll write the summary." },
        { agent: "A", text: "I'll verify the endpoint." },
        { agent: "B", text: "Waiting on C2." },
        { agent: "A", text: "@chorus resolved C2" },
      ]),
    );
    const s = r.room.state;
    assert.equal(s.dependencies.get("P1")!.status, "resolved");
    assert.equal(s.commitments.get("C1")!.status, "in_progress");
    assert.ok(r.posted.some((p) => p.type === "dependency_resolved"));
  });

  it("a low-confidence answer marker does not close a question", async () => {
    const lowAnswer: Extractor = {
      name: "claude",
      async extract(text) {
        return text.endsWith("?") ? [event("question", { text }, { confidence: 0.95 })] : [event("answer", {}, { confidence: 0.4 })];
      },
    };
    const clock = new VirtualClock();
    const t = new ReplayTransport([{ id: "A" }, { id: "B" }], () => clock.now());
    const r = room(t, clock, lowAnswer);
    await r.start();
    const q = await t.deliver("A", "Does the API support refunds?");
    await t.deliver("B", "Hmm, maybe.", q.id);
    await r.idle();
    assert.equal(r.state.questions.get("Q1")!.status, "open");
  });

  it("'Got it' replying to another message does not accept the only pending handoff", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Bob, check the receipt endpoint." },
        { agent: "C", text: "The layout is final." },
        { agent: "B", text: "Got it.", reply_to: 1 },
      ]),
    );
    assert.equal(r.room.state.handoffs.get("H1")!.status, "pending");
  });

  it("a dependency released by an expired deadline says so", async () => {
    const r = await replay(
      fixture(
        [
          { t: "+0s", agent: "A", text: "I'll verify the endpoint in 5 minutes." },
          { t: "+10s", agent: "B", text: "Waiting on C1." },
        ],
        { advance_clock_to: "+320s" },
      ),
    );
    const notice = r.posted.find((p) => p.type === "dependency_resolved")!;
    assert.match(notice.text, /C1 "verify the endpoint" expired without being completed \(deadline passed\)/);
    assert.doesNotMatch(notice.text, /already done/);
  });
});

describe("feedback and sessions", () => {
  it("@chorus wrong on a reminder suppresses its later resurfacing too", async () => {
    const filler = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ t: `+${from + i * 5}s`, agent: "C", text: `Layout step ${i + 1} filed.` }));
    const r = await replay(
      fixture([
        { t: "+0s", agent: "A", text: "Does the API support refunds?" },
        ...filler(12, 5),
        { t: "+70s", agent: "A", text: "@chorus wrong Q1" },
        ...filler(40, 75),
      ]),
    );
    assert.equal(r.posted.filter((p) => p.type === "unanswered_question").length, 1);
  });

  it("a mode change during a watch still issues the session receipt", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "@chorus watch 10" },
        { agent: "A", text: "@chorus mode observe" },
      ], { mode: "assist" }),
    );
    assert.match(r.posted.at(-1)!.text, /^Mode set to observe\.\n\nWatch ended by a mode change\./);
    assert.equal(r.room.state.receipts.length, 1);
    assert.equal(r.room.state.mode, "observe");
  });
});

describe("SharedNet transport", () => {
  it("hands a whole page to the room at once so a backlog can be batched", async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      id: `msg_${i + 1}`,
      room_id: "rom_x",
      sequence: i + 1,
      sender_instance_id: "i_a",
      content: `message ${i + 1}`,
      reply_to_message_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    let served = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/instances/current")) return new Response(JSON.stringify({ instance: { id: "i_self" } }));
      if (!served) {
        served = true;
        return new Response(JSON.stringify({ items, next_cursor: "7", has_more: false }));
      }
      return new Promise(() => {}); // later waits hang until close()
    }) as typeof fetch;
    try {
      const t = new SharedNetTransport({ baseUrl: "https://example.test", roomId: "rom_x", token: "sni_test" });
      const started: number[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      t.onMessage(async (m) => {
        started.push(m.seq);
        await gate;
      });
      await t.connect();
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7], "all seven delivered before any finished");
      release();
      await t.close();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
