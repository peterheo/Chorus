// Spec §35 idempotency and §69/§70 snapshot + recovery.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ChorusRoom, interventionKey } from "../src/chorus.ts";
import { VirtualClock } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { HeuristicConfirmer } from "../src/confirm.ts";
import { HeuristicExtractor } from "../src/extract/heuristic.ts";
import { replay } from "../src/replay.ts";
import { RoomState } from "../src/state/room.ts";
import { SqliteStore, type Store } from "../src/store.ts";
import { ReplayTransport } from "../src/transport/replay.ts";

const dir = mkdtempSync(join(tmpdir(), "chorus-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const roster = [
  { id: "A", name: "A" },
  { id: "B", name: "B" },
];

function makeRoom(transport: ReplayTransport, store: Store, clock: VirtualClock) {
  return new ChorusRoom({
    transport,
    store,
    roomKey: "rom_test",
    extractor: new HeuristicExtractor(),
    confirmer: new HeuristicConfirmer(),
    clock,
    config: { ...defaultConfig, mode: "facilitate" },
  });
}

describe("persistence", () => {
  it("snapshot round-trips through JSON", async () => {
    const r = await replay({
      room: "rt",
      mode: "facilitate",
      agents: [{ id: "A" }, { id: "B" }],
      messages: [
        { agent: "A", text: "Does the API support refunds?" },
        { agent: "B", text: "I'll check the pricing." },
        { agent: "A", text: "B, verify the receipt endpoint." },
        { agent: "A", text: "Refunds are supported." },
        { agent: "B", text: "Refunds are not supported." },
      ],
    });
    const asJson = (s: RoomState) => JSON.parse(JSON.stringify(s.toJSON()));
    const restored = RoomState.fromJSON(asJson(r.room.state));
    assert.deepEqual(asJson(restored), asJson(r.room.state));
    assert.equal(restored.nextId("question"), "Q2");
  });

  it("a restarted Chorus resumes with its state", async () => {
    const store = new SqliteStore(join(dir, "resume.db"));
    const clock = new VirtualClock();
    const transport = new ReplayTransport(roster, () => clock.now());

    const first = makeRoom(transport, store, clock);
    await first.start();
    await transport.deliver("A", "Does the API support refunds?");
    await first.idle();

    const saved = store.load("rom_test")!;
    assert.equal(saved.lastProcessedSeq, 1);

    // Restart: a new process with the same database.
    const second = makeRoom(transport, store, clock);
    await second.start();
    assert.equal(second.state.questions.get("Q1")!.status, "open");
    await transport.deliver("B", "Yes. Refunds are supported.", "msg_1");
    await second.idle();
    assert.equal(second.state.questions.get("Q1")!.status, "answered");
    assert.equal(store.load("rom_test")!.lastProcessedSeq, 2);
    store.close();
  });

  it("a crash after posting but before committing does not post twice", async () => {
    const inner = new SqliteStore(join(dir, "crash.db"));
    // Once "crashed", the old process never commits again (it is dead);
    // the restarted process gets a fresh, working store on the same file.
    let crashed = false;
    const dying: Store = {
      load: (k) => inner.load(k),
      commit: (k, c) => {
        if (crashed) throw new Error("simulated crash before commit");
        inner.commit(k, c);
      },
      close: () => {},
    };
    const clock = new VirtualClock();
    const transport = new ReplayTransport(roster, () => clock.now());

    const first = makeRoom(transport, dying, clock);
    await first.start();
    const m1 = await transport.deliver("A", "I'll check the pricing.");
    await first.idle();
    crashed = true; // the message that triggers the duplicate warning never commits
    const m2 = await transport.deliver("B", "I'll investigate the pricing.");
    await first.idle();
    assert.equal(transport.sent.length, 1);

    // Restart from the last good commit and redeliver what was not committed.
    const second = makeRoom(transport, inner, clock);
    await second.start();
    assert.equal(second.state.lastProcessedSeq, m1.seq);
    await transport.redeliver(m2);
    await second.idle();

    // Same candidate, same key: the transport returned the stored message.
    assert.equal(transport.sent.length, 1);
    assert.equal(second.state.posted.filter((p) => p.candidate.type === "duplicate_work").length, 1);
    inner.close();
  });

  it("intervention keys are deterministic UUID v4 strings", () => {
    const k = interventionKey("rom_x", "i_self", "duplicate_work:C1:C2#1");
    assert.equal(k, interventionKey("rom_x", "i_self", "duplicate_work:C1:C2#1"));
    assert.notEqual(k, interventionKey("rom_x", "i_self", "duplicate_work:C1:C2#2"));
    assert.match(k, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
