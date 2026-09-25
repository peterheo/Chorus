// Spec §10.4 decisions, §10.6 dependencies, §23 repeated questions,
// §23.1 decision reminders, §24 dependency notifications.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replay } from "../src/replay.ts";

const agents = [
  { id: "A", display_name: "Alice" },
  { id: "B", display_name: "Bob" },
  { id: "C", display_name: "Cara" },
];
type Msg = { t?: string; agent: string; text: string; reply_to?: number };
const fixture = (messages: Msg[], extra: Record<string, unknown> = {}) => ({
  room: "decisions",
  mode: "facilitate",
  agents,
  messages,
  ...extra,
});
const types = (r: Awaited<ReturnType<typeof replay>>) => r.posted.map((p) => p.type);

describe("decisions", () => {
  it("records decisions and supersedes one on the same subject", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Decided: the output format is JSON." },
        { agent: "B", text: "Decided: the output format is YAML." },
        { agent: "C", text: "@chorus decisions" },
      ]),
    );
    const s = r.room.state;
    assert.equal(s.decisions.get("D1")!.status, "superseded");
    assert.equal(s.decisions.get("D1")!.supersededBy, "D2");
    assert.equal(s.decisions.get("D2")!.status, "active");
    assert.match(r.posted.at(-1)!.text, /D1 — the output format is JSON \(Alice, #1\) \[superseded by D2\]/);
  });

  it("reminds the room when a claim contradicts an active decision", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Decided: the output format is JSON." },
        { agent: "B", text: "The output format is JSON." },
        { agent: "B", text: "The output format is CSV." },
      ]),
    );
    assert.deepEqual(types(r), ["decision_reminder"]);
    assert.match(r.posted[0]!.text, /^Note: this differs from D1 — "the output format is JSON" \(decided at #1\)\./);
    assert.equal(r.posted[0]!.seq, 4);
  });

  it("a reopened decision is no longer enforced", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Decided: the output format is JSON." },
        { agent: "C", text: "@chorus reopen D1" },
        { agent: "B", text: "The output format is CSV." },
      ]),
    );
    assert.equal(r.room.state.decisions.get("D1")!.status, "reopened");
    assert.deepEqual(types(r), ["reply"]); // only the reopen confirmation
  });
});

describe("dependencies", () => {
  it("blocks the waiter's commitment and notifies them when the blocker completes", async () => {
    const r = await replay(
      fixture([
        { agent: "B", text: "I'll write the summary." },
        { agent: "A", text: "I'll verify the refund endpoint." },
        { agent: "B", text: "I'm blocked on Alice's refund check." },
        { agent: "A", text: "Verified the refund endpoint." },
      ]),
    );
    const s = r.room.state;
    const p = s.dependencies.get("P1")!;
    assert.equal(p.blockingObjectId, "C2");
    assert.equal(p.blockedCommitmentId, "C1");
    assert.equal(p.status, "resolved");
    assert.equal(s.commitments.get("C1")!.status, "in_progress");
    assert.ok(s.transitions.some((t) => t.objectId === "C1" && t.to === "blocked"));
    assert.deepEqual(types(r), ["dependency_resolved"]);
    assert.match(r.posted[0]!.text, /^Bob — P1 is resolved: C2 "verify the refund endpoint" finished at #4\./);
  });

  it("tells an agent right away when they wait on something already finished", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "I'll verify the refund endpoint." },
        { agent: "A", text: "Verified the refund endpoint." },
        { agent: "B", text: "Waiting on C1." },
      ]),
    );
    assert.equal(r.room.state.dependencies.get("P1")!.status, "resolved");
    assert.deepEqual(types(r), ["dependency_resolved"]);
    assert.match(r.posted[0]!.text, /C1 "verify the refund endpoint" is already done/);
  });

  it("answers what-am-i-waiting-on", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "I'll verify the refund endpoint." },
        { agent: "B", text: "Waiting on C1." },
        { agent: "B", text: "Cara, check the receipt endpoint." },
        { agent: "B", text: "@chorus what-am-i-waiting-on" },
      ]),
    );
    const reply = r.posted.at(-1)!.text;
    assert.match(reply, /P1 → C1 verify the refund endpoint \[in_progress\]/);
    assert.match(reply, /H1 → Cara to accept: check the receipt endpoint/);
  });

  it("a pending dependency adds to a commitment's staleness", async () => {
    const r = await replay(
      fixture([
        { t: "+0s", agent: "A", text: "I'll verify the refund endpoint." },
        { t: "+5s", agent: "B", text: "Blocked on C1." },
        { t: "+10s", agent: "C", text: "Blocked on C1." },
        ...Array.from({ length: 20 }, (_, i) => ({ t: `+${30 + i * 20}s`, agent: i % 4 === 0 ? "A" : "C", text: `Note ${i + 1} filed.` })),
      ]),
    );
    // Two blocked dependents push the score over the threshold well before
    // the no-dependents case would (compare the stale test in handoff.test.ts).
    assert.ok(types(r).includes("stale_commitment"));
  });
});

describe("repeated questions", () => {
  it("quotes the earlier answer instead of letting the question go unanswered", async () => {
    const r = await replay(
      fixture(
        [
          { t: "+0s", agent: "A", text: "Does the API support refunds?" },
          { t: "+5s", agent: "B", text: "Yes. Refunds are supported within 24 hours." },
          { t: "+60s", agent: "C", text: "Does the API support refunds?" },
        ],
        { advance_clock_to: "+400s" },
      ),
    );
    assert.deepEqual(types(r), ["repeated_question"]);
    assert.match(r.posted[0]!.text, /^This appears to match Q1, which was previously answered\./);
    assert.match(r.posted[0]!.text, /Answer: Bob \(#2\): Yes\. Refunds are supported within 24 hours\./);
  });

  it("is also posted in assist mode", async () => {
    const r = await replay(
      fixture(
        [
          { agent: "A", text: "Does the API support refunds?" },
          { agent: "B", text: "Yes. Refunds are supported." },
          { agent: "C", text: "Does the API support refunds?" },
        ],
        { mode: "assist" },
      ),
    );
    assert.deepEqual(types(r), ["repeated_question"]);
  });

  it("does not quote an answer that is contested", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Does the API support refunds?" },
        { agent: "B", text: "Refunds are supported.", reply_to: 0 },
        { agent: "C", text: "Refunds are not supported." },
        { agent: "C", text: "Does the API support refunds?" },
      ]),
    );
    assert.ok(!types(r).includes("repeated_question"));
  });
});
