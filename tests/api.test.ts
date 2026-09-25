// Spec §31 state API, §32 SSE events, §41 object history.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApiServer } from "../src/api/server.ts";
import { ChorusRoom } from "../src/chorus.ts";
import { VirtualClock } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { HeuristicConfirmer } from "../src/confirm.ts";
import { HeuristicExtractor } from "../src/extract/heuristic.ts";
import { ReplayTransport } from "../src/transport/replay.ts";

const TOKEN = "test-token-123";
const clock = new VirtualClock();
const transport = new ReplayTransport(
  [
    { id: "A", name: "Alice" },
    { id: "B", name: "Bob" },
  ],
  () => clock.now(),
);
const room = new ChorusRoom({
  transport,
  extractor: new HeuristicExtractor(),
  confirmer: new HeuristicConfirmer(),
  clock,
  config: { ...defaultConfig, mode: "assist" },
});
const server = createApiServer({ rooms: new Map([["rom_test", room]]), token: TOKEN, heartbeatMs: 60_000 });
let base = "";

async function say(agent: string, text: string, replyTo?: string) {
  clock.advanceSeconds(5);
  const m = await transport.deliver(agent, text, replyTo);
  await room.idle();
  return m;
}

async function get(path: string, token: string | null = TOKEN) {
  const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: (await res.json()) as any };
}

/** Read SSE frames until `n` events have arrived (fails after 3 s instead of hanging). */
async function readEvents(res: Response, n: number): Promise<Array<{ id: number; event: string; data: any }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ id: number; event: string; data: any }> = [];
  let buf = "";
  const deadline = setTimeout(() => void reader.cancel(), 3000);
  while (events.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (frame.startsWith(":")) continue;
      const f = Object.fromEntries(frame.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
      events.push({ id: Number(f.id), event: f.event!, data: JSON.parse(f.data!) });
    }
  }
  clearTimeout(deadline);
  await reader.cancel();
  return events;
}

before(async () => {
  await room.start();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe("state API", () => {
  it("requires the bearer token", async () => {
    assert.equal((await get("/v1/rooms/rom_test/state", null)).status, 401);
    assert.equal((await get("/v1/rooms/rom_test/state", "wrong")).status, 401);
    assert.equal((await get("/v1/rooms/nope/state")).status, 404);
  });

  it("serves state, open items, decisions, agent context and history", async () => {
    const q = await say("A", "Does the API support refunds?");
    await say("B", "I'll verify the refund endpoint.");
    await say("A", "Bob, check the receipt endpoint.");
    await say("A", "Decided: the output format is JSON.");
    await say("A", "Waiting on C1.");

    const state = await get("/v1/rooms/rom_test/state");
    assert.equal(state.status, 200);
    assert.equal(state.body.room_id, "rom_test");
    assert.equal(state.body.as_of_sequence, 5);
    assert.deepEqual(state.body.questions, { open: 1, answered: 0 });
    assert.equal(state.body.handoffs.pending, 1);
    assert.equal(state.body.dependencies.waiting, 1);
    assert.equal(state.body.decisions.active, 1);
    assert.equal(state.body.coordination_complete, false);

    const open = await get("/v1/rooms/rom_test/open-items");
    const ids = open.body.items.map((i: any) => i.id);
    assert.deepEqual(ids, ["Q1", "C1", "H1", "P1"]);
    assert.equal(open.body.items[0].source_message, q.seq);

    const decisions = await get("/v1/rooms/rom_test/decisions");
    assert.equal(decisions.body.decisions[0].statement, "the output format is JSON");

    const ctxB = await get("/v1/rooms/rom_test/agents/B/context");
    assert.deepEqual(ctxB.body.commitments, ["C1"]);
    assert.deepEqual(ctxB.body.handoffs_to_you, ["H1"]);
    const ctxA = await get("/v1/rooms/rom_test/agents/A/context");
    assert.deepEqual(ctxA.body.waiting_on, ["C1"]);
    assert.deepEqual(ctxA.body.your_open_questions, ["Q1"]);

    const hist = await get("/v1/rooms/rom_test/objects/q1/history");
    assert.equal(hist.body.object.id, "Q1");
    assert.equal(hist.body.transitions[0].to, "open");
    assert.equal(hist.body.source_messages[0].text, "Does the API support refunds?");
    assert.equal((await get("/v1/rooms/rom_test/objects/Q99/history")).status, 404);
  });
});

describe("SSE events", () => {
  it("streams new events and resumes from Last-Event-ID", async () => {
    const res = await fetch(`${base}/v1/rooms/rom_test/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const pending = readEvents(res, 2);
    await say("B", "Verified the refund endpoint.");
    const live = await pending;
    assert.deepEqual(
      live.map((e) => e.event),
      ["commitment.completed", "dependency.resolved"],
    );
    assert.equal(live[0]!.data.commitment_id, "C1");
    assert.equal(typeof live[0]!.data.sequence, "number");

    // Resume: everything after the first live event is replayed.
    const resumed = await fetch(`${base}/v1/rooms/rom_test/events`, {
      headers: { authorization: `Bearer ${TOKEN}`, "last-event-id": String(live[0]!.id) },
    });
    const replayed = await readEvents(resumed, 1);
    assert.equal(replayed[0]!.id > live[0]!.id, true);
    assert.equal(replayed[0]!.event, live[1]!.event);
  });

  it("emits room.ready_to_close when the room clears", async () => {
    const lastId = room.eventsSince(-1).at(-1)!.id;
    // Clear everything still open: the question and the handoff.
    await say("A", "@chorus resolved Q1");
    await say("B", "Sorry, I can't take this one.");
    assert.equal((await get("/v1/rooms/rom_test/state")).body.coordination_complete, true);

    const res = await fetch(`${base}/v1/rooms/rom_test/events?after=${lastId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const events = (await readEvents(res, 3)).map((e) => e.event);
    assert.deepEqual(events, ["question.answered", "handoff.declined", "room.ready_to_close"]);
  });
});
