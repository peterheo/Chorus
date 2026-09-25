// Spec §51 candidate merging, §26 deadlock detection and blocked-agent annotations.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { InterventionPolicy, merge } from "../src/policy.ts";
import { replay } from "../src/replay.ts";
import { RoomState } from "../src/state/room.ts";
import type { InterventionCandidate } from "../src/state/types.ts";

const agents = [
  { id: "A", display_name: "Alice" },
  { id: "B", display_name: "Bob" },
  { id: "C", display_name: "Cara" },
];
type Msg = { t?: string; agent: string; text: string };
const fixture = (messages: Msg[], extra: Record<string, unknown> = {}) => ({
  room: "merge",
  mode: "facilitate",
  agents,
  messages,
  ...extra,
});
const types = (r: Awaited<ReturnType<typeof replay>>) => r.posted.map((p) => p.type);

function candidate(over: Partial<InterventionCandidate>): InterventionCandidate {
  return {
    type: "unanswered_question",
    severity: "medium",
    involvedAgentIds: ["A"],
    relatedObjectIds: ["Q1"],
    evidenceMessageIds: ["m1"],
    confidence: 0.95,
    urgency: 0.8,
    expectedValue: 0.9,
    blockedAgents: 0,
    idempotencyKey: "k1",
    text: "first",
    createdIndex: 0,
    ...over,
  };
}

describe("merging (§51)", () => {
  it("absorbs candidates about the same object into one message", () => {
    const top = candidate({});
    const same = candidate({ type: "stale_commitment", relatedObjectIds: ["Q1", "C1"], idempotencyKey: "k2", text: "second" });
    const other = candidate({ relatedObjectIds: ["Q9"], idempotencyKey: "k3", text: "unrelated" });
    const m = merge(top, [top, same, other]);
    assert.deepEqual(m.absorbedKeys, ["k2"]);
    assert.deepEqual(m.relatedObjectIds, ["Q1", "C1"]);
    assert.equal(m.text, "first\n\n—\n\nsecond");
  });

  it("does not raise an absorbed candidate again", () => {
    const state = new RoomState("facilitate");
    const policy = new InterventionPolicy(() => defaultConfig);
    const now = new Date();
    const a = candidate({});
    const b = candidate({ type: "stale_commitment", idempotencyKey: "k2", text: "second", urgency: 0.5 });
    const first = policy.choose(state, [a, b], now).post!;
    assert.deepEqual(first.absorbedKeys, ["k2"]);
    state.posted.push({ candidate: first, postedAt: now.toISOString(), postedIndex: 0, solicited: false });
    state.roomIndex = 50; // well past every rate limit
    assert.equal(policy.choose(state, [b], new Date(now.getTime() + 600_000)).post, null);
  });
});

describe("blocked agents", () => {
  it("an unanswered question names who is blocked on it (§51 example)", async () => {
    const r = await replay(
      fixture([
        { t: "+0s", agent: "A", text: "Does the API support refunds?" },
        { t: "+5s", agent: "B", text: "I'll write the refund section." },
        { t: "+10s", agent: "B", text: "Waiting on Q1." },
        ...Array.from({ length: 12 }, (_, i) => ({ t: `+${15 + i * 5}s`, agent: "C", text: `Layout step ${i + 1} filed.` })),
      ]),
    );
    const posted = r.posted.find((p) => p.type === "unanswered_question");
    assert.ok(posted, `expected an unanswered_question, got ${types(r).join(", ")}`);
    assert.match(posted.text, /Q1 — Does the API support refunds\?/);
    assert.match(posted.text, /Blocked on it: Bob \(P1\)\./);
    assert.equal(r.room.state.commitments.get("C1")!.status, "blocked");
  });
});

describe("deadlock (§26)", () => {
  it("detects agents waiting on each other, even in assist mode", async () => {
    const r = await replay(
      fixture(
        [
          { agent: "A", text: "I'll write the report." },
          { agent: "B", text: "I'll review the data." },
          { agent: "A", text: "Blocked on C2." },
          { agent: "B", text: "Blocked on C1." },
        ],
        { mode: "assist" },
      ),
    );
    assert.deepEqual(types(r), ["dependency_deadlock"]);
    const text = r.posted[0]!.text;
    assert.match(text, /^Possible deadlock/);
    assert.match(text, /Alice waits on C2 \(Bob\)/);
    assert.match(text, /Bob waits on C1 \(Alice\)/);
  });

  it("is reported once per cycle", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "I'll write the report." },
        { agent: "B", text: "I'll review the data." },
        { agent: "A", text: "Blocked on C2." },
        { agent: "B", text: "Blocked on C1." },
        { agent: "C", text: "The layout is done." },
        { agent: "C", text: "The index is done." },
      ]),
    );
    assert.equal(types(r).filter((t) => t === "dependency_deadlock").length, 1);
  });
});
