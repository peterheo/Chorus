// Spec §16.2/§16.3 deadlines and expiry, handoff transfers, §12.1 alias learning.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDeadline } from "../src/deadline.ts";
import { replay } from "../src/replay.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const agents = [
  { id: "A", display_name: "Alice" },
  { id: "B", display_name: "Bob" },
  { id: "i_guest01" }, // a guest seat with no display name, as SharedNet invites produce
];
type Msg = { t?: string; agent: string; text: string };
const fixture = (messages: Msg[], extra: Record<string, unknown> = {}) => ({
  room: "deadlines",
  mode: "facilitate",
  agents,
  messages,
  ...extra,
});

describe("parseDeadline", () => {
  it("parses relative, clock and ISO deadlines", () => {
    assert.equal(parseDeadline("verify it in 10 minutes", T0)?.deadline, "2026-01-01T00:10:00.000Z");
    assert.equal(parseDeadline("verify it in 10 minutes", T0)?.rest, "verify it");
    assert.equal(parseDeadline("done within 2 hours", T0)?.deadline, "2026-01-01T02:00:00.000Z");
    assert.equal(parseDeadline("check it by 14:30", T0)?.deadline, "2026-01-01T14:30:00.000Z");
    assert.equal(parseDeadline("check it by 3pm", T0)?.deadline, "2026-01-01T15:00:00.000Z");
    assert.equal(parseDeadline("2026-01-01T05:00:00Z", T0)?.deadline, "2026-01-01T05:00:00.000Z");
  });

  it("rolls a past clock time to the next day and ignores bare numbers", () => {
    const noon = new Date("2026-01-01T12:00:00.000Z");
    assert.equal(parseDeadline("by 09:00", noon)?.deadline, "2026-01-02T09:00:00.000Z");
    assert.equal(parseDeadline("look at 3 endpoints", T0), null);
    assert.equal(parseDeadline("no deadline here", T0), null);
  });
});

describe("expiry", () => {
  it("a commitment with a stated deadline expires on the tick after it passes", async () => {
    const r = await replay(
      fixture([{ t: "+0s", agent: "A", text: "I'll verify the endpoint in 10 minutes." }], { advance_clock_to: "+620s" }),
    );
    const c = r.room.state.commitments.get("C1")!;
    assert.equal(c.action, "verify the endpoint");
    assert.equal(c.deadline, "2026-01-01T00:10:00.000Z");
    assert.equal(c.status, "expired");
    const t = r.room.state.transitions.find((x) => x.objectId === "C1" && x.to === "expired")!;
    assert.equal(t.cause, "tick");
    assert.equal(t.reason, "deadline");
  });

  it("without a deadline a commitment never expires", async () => {
    const r = await replay(fixture([{ t: "+0s", agent: "A", text: "I'll verify the endpoint." }], { advance_clock_to: "+3600s" }));
    assert.equal(r.room.state.commitments.get("C1")!.status, "in_progress");
  });

  it("an expired commitment releases agents waiting on it", async () => {
    const r = await replay(
      fixture(
        [
          { t: "+0s", agent: "A", text: "I'll verify the endpoint in 5 minutes." },
          { t: "+10s", agent: "B", text: "Waiting on C1." },
        ],
        { advance_clock_to: "+320s" },
      ),
    );
    assert.equal(r.room.state.dependencies.get("P1")!.status, "resolved");
    assert.ok(r.posted.some((p) => p.type === "dependency_resolved"));
  });

  it("a pending handoff with a deadline expires", async () => {
    const r = await replay(
      fixture([{ t: "+0s", agent: "A", text: "Bob, check the receipt endpoint within 5 minutes." }], {
        advance_clock_to: "+320s",
      }),
    );
    const h = r.room.state.handoffs.get("H1")!;
    assert.equal(h.action, "check the receipt endpoint");
    assert.equal(h.status, "expired");
  });
});

describe("transfers", () => {
  it("'take over my C1' hands the commitment over and cancels the original", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "I'll draft the summary by 14:00." },
        { agent: "A", text: "Bob, take over my C1." },
        { agent: "B", text: "Got it." },
      ]),
    );
    const s = r.room.state;
    const h = s.handoffs.get("H1")!;
    assert.equal(h.transfersCommitmentId, "C1");
    assert.equal(h.action, "draft the summary");
    assert.equal(s.commitments.get("C1")!.status, "cancelled");
    const c2 = s.commitments.get("C2")!;
    assert.equal(c2.ownerId, "B");
    assert.equal(c2.action, "draft the summary");
    assert.equal(c2.deadline, s.commitments.get("C1")!.deadline);
    assert.equal(s.transitions.find((t) => t.objectId === "C1" && t.to === "cancelled")!.reason, "transferred to C2");
  });
});

describe("aliases (§12.1)", () => {
  it("learns a name from self-identification and resolves requests with it", async () => {
    const r = await replay(
      fixture([
        { agent: "i_guest01", text: "Hi, I'm the verifier." },
        { agent: "A", text: "verifier, check the refund claim." },
      ]),
    );
    const s = r.room.state;
    assert.equal(s.agents.get("i_guest01")!.displayName, "verifier");
    assert.equal(s.handoffs.get("H1")!.toAgentId, "i_guest01");
  });

  it("does not take a name another agent already has, or ordinary phrases", async () => {
    const r = await replay(
      fixture([
        { agent: "i_guest01", text: "I'm Alice." },
        { agent: "B", text: "I'm done." },
        { agent: "B", text: "I'm checking the logs." },
      ]),
    );
    const s = r.room.state;
    assert.deepEqual(s.agents.get("i_guest01")!.aliases, []);
    assert.deepEqual(s.agents.get("B")!.aliases, []);
  });
});
