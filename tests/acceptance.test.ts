// Spec §77 acceptance tests, run through the replay harness with the virtual
// clock and the deterministic extractor/confirmer.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { replay } from "../src/replay.ts";
import { CHORUS_REPLAY_ID } from "../src/transport/replay.ts";

const agents = [
  { id: "A", display_name: "A" },
  { id: "B", display_name: "B" },
  { id: "C", display_name: "C" },
];

type Msg = { t?: string; agent: string; text: string; reply_to?: number; deliver_twice?: boolean };

function fixture(messages: Msg[], extra: Record<string, unknown> = {}) {
  return { room: "test", mode: "facilitate", agents, messages, ...extra };
}

function fillers(n: number, startSeconds: number, agent = "C"): Msg[] {
  return Array.from({ length: n }, (_, i) => ({
    t: `+${startSeconds + i * 5}s`,
    agent,
    text: `Working on layout step ${i + 1}.`,
  }));
}

const types = (r: Awaited<ReturnType<typeof replay>>) => r.posted.map((p) => p.type);

describe("§77 acceptance", () => {
  it("Test 1 — duplicate work", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "I'll check the pricing." },
        { agent: "B", text: "I'll investigate the pricing." },
      ]),
    );
    assert.deepEqual(types(r), ["duplicate_work"]);
    assert.match(r.posted[0]!.text, /A → C1 check the pricing \(#1\)/);
  });

  it("Test 2 — different work is not a duplicate", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "I'll check pricing." },
        { agent: "B", text: "I'll check authentication." },
      ]),
    );
    assert.deepEqual(types(r), []);
    assert.equal(r.room.state.activeCommitments().length, 2);
  });

  it("Test 3a — unanswered question, busy room (message count)", async () => {
    const r = await replay(
      fixture([{ t: "+0s", agent: "A", text: "Does the API support refunds?" }, ...fillers(12, 5)]),
    );
    assert.deepEqual(types(r), ["unanswered_question"]);
    // Posted right after the 12th filler (#13), not before.
    assert.equal(r.posted[0]!.seq, 14);
    assert.match(r.posted[0]!.text, /Q1 — Does the API support refunds\?/);
    assert.match(r.posted[0]!.text, /Asked by A at #1/);
  });

  it("Test 3b — unanswered question, quiet room (wall-clock fallback)", async () => {
    const r = await replay(
      fixture(
        [
          { t: "+0s", agent: "A", text: "Does the API support refunds?" },
          { t: "+20s", agent: "B", text: "ok" },
        ],
        { advance_clock_to: "+310s" },
      ),
    );
    assert.deepEqual(types(r), ["unanswered_question"]);
    assert.equal(r.posted[0]!.t, 300);
  });

  it("Test 3c — Chorus messages do not count as room activity", async () => {
    const msgs = fillers(12, 5).map((m, i) => (i % 3 === 0 ? { ...m, agent: CHORUS_REPLAY_ID } : m));
    const r = await replay(fixture([{ t: "+0s", agent: "A", text: "Does the API support refunds?" }, ...msgs]));
    assert.deepEqual(types(r), []);
    assert.equal(r.room.state.roomIndex, 9); // question + 8 agent fillers
  });

  it("Test 4 — answered question", async () => {
    const r = await replay(
      fixture(
        [
          { t: "+0s", agent: "A", text: "Does the API support refunds?" },
          { t: "+5s", agent: "B", text: "Yes. Refunds are supported for 24 hours." },
          ...fillers(14, 10),
        ],
        { advance_clock_to: "+400s" },
      ),
    );
    const s = r.room.state;
    assert.equal(s.questions.get("Q1")!.status, "answered");
    const k = s.claims.get("K1")!;
    assert.equal(k.polarity, "positive");
    assert.deepEqual(k.conditions, ["for 24 hours"]);
    assert.equal(k.answersQuestionId, "Q1");
    assert.ok(!types(r).includes("unanswered_question"));
  });

  it("Test 5 — conflict", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Refunds are supported." },
        { agent: "B", text: "Refunds are not supported." },
      ]),
    );
    const s = r.room.state;
    assert.equal(s.claims.size, 2);
    assert.equal(s.conflicts.get("X1")!.status, "confirmed");
    assert.deepEqual(types(r), ["conflict_detected"]);
  });

  it("Test 6 — context-specific non-conflict", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Refunds are supported in the first 24 hours." },
        { agent: "B", text: "Refunds are not supported after 24 hours." },
      ]),
    );
    const s = r.room.state;
    assert.equal(s.claims.size, 2);
    assert.deepEqual(s.claims.get("K1")!.conditions, ["in the first 24 hours"]);
    assert.deepEqual(s.claims.get("K2")!.conditions, ["after 24 hours"]);
    assert.equal(s.conflicts.size, 0);
  });

  it("Test 7 — duplicate delivery creates no duplicate state", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "I'll check the pricing." },
        { agent: "B", text: "I'll investigate the pricing.", deliver_twice: true },
      ]),
    );
    assert.equal(r.room.state.commitments.size, 2);
    assert.deepEqual(types(r), ["duplicate_work"]);
  });

  it("Test 8 — unauthorized feedback changes nothing", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Does the API support refunds?" },
        { agent: "C", text: "@chorus resolved Q1" },
      ]),
    );
    assert.equal(r.room.state.questions.get("Q1")!.status, "open");
    assert.match(r.posted[0]!.text, /Not applied: only the asker or an answerer may resolve Q1/);
  });

  it("the asker may resolve their own question", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Does the API support refunds?" },
        { agent: "A", text: "@chorus resolved Q1" },
      ]),
    );
    assert.equal(r.room.state.questions.get("Q1")!.status, "answered");
  });
});

describe("modes and self-messages", () => {
  it("assist mode posts confirmed conflicts but not duplicates", async () => {
    const r = await replay(
      fixture(
        [
          { agent: "A", text: "I'll check the pricing." },
          { agent: "B", text: "I'll investigate the pricing." },
          { agent: "A", text: "Refunds are supported." },
          { agent: "B", text: "Refunds are not supported." },
        ],
        { mode: "assist" },
      ),
    );
    assert.deepEqual(types(r), ["conflict_detected"]);
  });

  it("observe mode never posts unsolicited, but still answers commands", async () => {
    const r = await replay(
      fixture(
        [
          { agent: "A", text: "Refunds are supported." },
          { agent: "B", text: "Refunds are not supported." },
          { agent: "A", text: "@chorus conflicts" },
        ],
        { mode: "observe" },
      ),
    );
    assert.deepEqual(types(r), ["reply"]);
    assert.match(r.posted[0]!.text, /X1 — refunds \[confirmed\]/);
  });

  it("Chorus's own messages produce no state", async () => {
    const r = await replay(
      fixture([
        { agent: CHORUS_REPLAY_ID, text: "Still unanswered: Does the API support refunds?" },
        { agent: CHORUS_REPLAY_ID, text: "I'll check the pricing." },
        { agent: CHORUS_REPLAY_ID, text: "Refunds are supported." },
      ]),
    );
    const s = r.room.state;
    assert.equal(s.questions.size + s.commitments.size + s.claims.size, 0);
  });

  it("a third disagreeing agent joins the existing conflict", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Streaming is supported." },
        { agent: "B", text: "Streaming is not supported." },
        { agent: "C", text: "No, streaming is not supported." },
      ]),
    );
    const s = r.room.state;
    assert.equal(s.conflicts.size, 1);
    assert.equal(s.conflicts.get("X1")!.claimIds.length, 3);
  });

  it("hedged claims form an unannounced candidate conflict", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "I think streaming is supported." },
        { agent: "B", text: "Streaming is not supported." },
      ]),
    );
    assert.equal(r.room.state.conflicts.get("X1")!.status, "candidate");
    assert.deepEqual(types(r), []);
  });

  it("facilitate mode announces READY TO CLOSE once after a quiet minute", async () => {
    const r = await replay(
      fixture(
        [
          { t: "+0s", agent: "A", text: "Does the API support refunds?" },
          { t: "+5s", agent: "B", text: "Yes. Refunds are supported." },
        ],
        { advance_clock_to: "+200s" },
      ),
    );
    assert.deepEqual(types(r), ["completion_check"]);
    assert.match(r.posted[0]!.text, /^READY TO CLOSE/);
  });
});

describe("§82 milestone", () => {
  it("runs the full milestone transcript", async () => {
    const r = await replay(JSON.parse(readFileSync(new URL("./fixtures/milestone.json", import.meta.url), "utf8")));
    assert.deepEqual(types(r), ["duplicate_work", "unanswered_question", "conflict_detected", "reply"]);
    assert.doesNotMatch(r.posted[0]!.text, /Still unclaimed: Q1/);
    assert.match(r.posted.at(-1)!.text, /^READY TO CLOSE/);
    const s = r.room.state;
    assert.equal(s.commitments.get("C1")!.status, "completed");
    assert.equal(s.commitments.get("C2")!.status, "cancelled");
    assert.equal(s.conflicts.get("X1")!.status, "resolved");
  });
});
