// Spec §78 facilitator election: with several Chorus instances in a room,
// only the lowest online instance ID speaks.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChorusRoom } from "../src/chorus.ts";
import { VirtualClock } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { HeuristicConfirmer } from "../src/confirm.ts";
import { HeuristicExtractor } from "../src/extract/heuristic.ts";
import { ReplayTransport } from "../src/transport/replay.ts";

async function setup() {
  const clock = new VirtualClock();
  const transport = new ReplayTransport(
    [{ id: "A", name: "Alice" }, { id: "B", name: "Bob" }, { id: "aaa-peer" }, { id: "zzz-peer" }],
    () => clock.now(),
  );
  const room = new ChorusRoom({
    transport,
    extractor: new HeuristicExtractor(),
    confirmer: new HeuristicConfirmer(),
    clock,
    config: { ...defaultConfig, mode: "assist" },
    election: true,
  });
  await room.start();
  await room.idle();
  const say = async (agent: string, text: string) => {
    await transport.deliver(agent, text);
    await room.idle();
  };
  return { room, transport, say };
}

const conflict = async (say: (a: string, t: string) => Promise<void>, subject: string) => {
  await say("A", `${subject} is supported.`);
  await say("B", `${subject} is not supported.`);
};

describe("facilitator election", () => {
  it("announces itself once on start", async () => {
    const { transport } = await setup();
    assert.equal(transport.sent.length, 1);
    assert.match(transport.sent[0]!.text, /^\[chorus\] online as chorus\./);
  });

  it("stands by while a lower-ID Chorus is online, and takes over when it goes offline", async () => {
    const { room, transport, say } = await setup();
    await say("aaa-peer", "[chorus] online as aaa-peer.");
    assert.equal(room.isSpeaker(), false);
    assert.equal(room.state.messages.at(-1)!.text.startsWith("[chorus]"), true);
    assert.equal(room.state.claims.size, 0, "a peer's announcement is never extracted");

    await conflict(say, "Streaming");
    assert.equal(room.state.conflicts.get("X1")!.status, "confirmed", "state is still tracked");
    assert.equal(transport.sent.length, 1, "but nothing is posted");

    room.state.agents.get("aaa-peer")!.presence = "offline";
    assert.equal(room.isSpeaker(), true);
    await conflict(say, "Refunds");
    assert.match(transport.sent.at(-1)!.text, /^Unresolved conflict X2: refunds/);
    // The conflict it stayed silent about is not re-announced after takeover.
    assert.equal(transport.sent.filter((m) => m.text.includes("X1")).length, 0);
  });

  it("keeps speaking when the other instance has a higher ID", async () => {
    const { room, transport, say } = await setup();
    await say("zzz-peer", "[chorus] online as zzz-peer.");
    assert.equal(room.isSpeaker(), true);
    await conflict(say, "Streaming");
    assert.match(transport.sent.at(-1)!.text, /^Unresolved conflict X1/);
  });
});
