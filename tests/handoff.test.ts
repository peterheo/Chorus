// Spec §16.3 handoffs, §20 missing acknowledgement, §21 stale commitments.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replay } from "../src/replay.ts";

const agents = [
  { id: "A", display_name: "ResearchA" },
  { id: "V", display_name: "Verifier" },
  { id: "W", display_name: "Writer" },
];
type Msg = { t?: string; agent: string; text: string; reply_to?: number };
const fixture = (messages: Msg[], extra: Record<string, unknown> = {}) => ({
  room: "handoff",
  mode: "facilitate",
  agents,
  messages,
  ...extra,
});
const types = (r: Awaited<ReturnType<typeof replay>>) => r.posted.map((p) => p.type);

describe("handoffs", () => {
  it("Scenario D: unacknowledged handoff is surfaced, then accepted and completed", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Verifier, please validate the refund claim." },
        { agent: "V", text: "The layout looks fine." },
        { agent: "V", text: "The colors are consistent." },
        { agent: "V", text: "The fonts are readable." },
        { agent: "V", text: "Got it.", reply_to: 0 },
        { agent: "V", text: "Verified the refund claim." },
        { agent: "A", text: "@chorus close-check" },
      ]),
    );
    assert.deepEqual(types(r), ["missing_acknowledgement", "reply"]);
    assert.match(r.posted[0]!.text, /^Verifier: handoff H1 from ResearchA has not been acknowledged\./);
    const s = r.room.state;
    const h = s.handoffs.get("H1")!;
    assert.equal(h.status, "completed");
    assert.equal(s.commitments.get(h.resultingCommitmentId!)!.fromHandoffId, "H1");
    assert.equal(s.commitments.get(h.resultingCommitmentId!)!.status, "completed");
    assert.match(r.posted[1]!.text, /^READY TO CLOSE/);
  });

  it("a commitment from the recipient accepts the handoff", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Verifier, check the receipt endpoint." },
        { agent: "V", text: "I'll check the receipt endpoint." },
      ]),
    );
    const s = r.room.state;
    assert.equal(s.handoffs.get("H1")!.status, "accepted");
    assert.equal(s.commitments.size, 1);
    assert.equal(s.commitments.get("C1")!.ownerId, "V");
  });

  it("the recipient can decline", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Verifier, check the receipt endpoint." },
        { agent: "V", text: "Sorry, I can't take this one." },
      ]),
    );
    assert.equal(r.room.state.handoffs.get("H1")!.status, "declined");
    assert.equal(r.room.state.commitments.size, 0);
  });

  it("a pending handoff blocks READY TO CLOSE", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Verifier, check the receipt endpoint." },
        { agent: "A", text: "@chorus close-check" },
      ]),
    );
    assert.match(r.posted.at(-1)!.text, /^NOT READY[\s\S]*1 pending handoff:\nH1 — ResearchA → Verifier/);
  });

  it("only the sender or recipient may resolve a handoff", async () => {
    const r = await replay(
      fixture([
        { agent: "A", text: "Verifier, check the receipt endpoint." },
        { agent: "W", text: "@chorus resolved H1" },
      ]),
    );
    assert.equal(r.room.state.handoffs.get("H1")!.status, "pending");
    assert.match(r.posted[0]!.text, /Not applied: only the sender or recipient may resolve H1/);
  });
});

describe("stale commitments", () => {
  it("surfaces an in-progress commitment with no update while its owner talks about other things", async () => {
    const chatter: Msg[] = [];
    for (let i = 0; i < 30; i++) {
      chatter.push({ t: `+${30 + i * 20}s`, agent: i % 5 === 0 ? "A" : "W", text: `Section ${i + 1} drafted.` });
    }
    const r = await replay(fixture([{ t: "+0s", agent: "A", text: "I'll verify the refund endpoint." }, ...chatter]));
    assert.deepEqual(types(r), ["stale_commitment"]);
    assert.match(r.posted[0]!.text, /^No update on C1 for \d+ messages/);
    assert.match(r.posted[0]!.text, /ResearchA → verify the refund endpoint \(#1\)/);
  });

  it("a status update resets staleness", async () => {
    const chatter: Msg[] = [];
    for (let i = 0; i < 30; i++) {
      chatter.push({ t: `+${30 + i * 20}s`, agent: i % 5 === 0 ? "A" : "W", text: `Section ${i + 1} drafted.` });
    }
    // An update halfway through, before the commitment would have gone stale.
    chatter.splice(14, 0, { t: "+300s", agent: "A", text: "Still checking the refund endpoint." });
    const r = await replay(fixture([{ t: "+0s", agent: "A", text: "I'll verify the refund endpoint." }, ...chatter]));
    assert.deepEqual(types(r), []);
  });
});
