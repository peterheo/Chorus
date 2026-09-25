// Incremental persistence: append-only message/transition tables, a small
// core snapshot, migration of full snapshots, and retention in storage.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { ChorusRoom } from "../src/chorus.ts";
import { VirtualClock } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { HeuristicConfirmer } from "../src/confirm.ts";
import { HeuristicExtractor } from "../src/extract/heuristic.ts";
import { SqliteStore } from "../src/store.ts";
import { ReplayTransport } from "../src/transport/replay.ts";

const dir = mkdtempSync(join(tmpdir(), "chorus-incr-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function makeRoom(store: SqliteStore, transport: ReplayTransport, clock: VirtualClock) {
  return new ChorusRoom({
    transport,
    store,
    roomKey: "rom_i",
    extractor: new HeuristicExtractor(),
    confirmer: new HeuristicConfirmer(),
    clock,
    config: { ...defaultConfig, mode: "assist" },
  });
}

const coreSize = (path: string) => {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT length(state_json) AS n, state_json FROM rooms WHERE room_id = 'rom_i'").get() as { n: number; state_json: string };
  const counts = db.prepare("SELECT (SELECT count(*) FROM state_messages) AS m, (SELECT count(*) FROM state_transitions) AS t").get() as {
    m: number;
    t: number;
  };
  db.close();
  return { bytes: row.n, hasMessages: "messages" in JSON.parse(row.state_json), ...counts };
};

describe("incremental persistence", () => {
  it("stores messages and transitions append-only; the core snapshot stays small", async () => {
    const path = join(dir, "grow.db");
    const store = new SqliteStore(path);
    const clock = new VirtualClock();
    const transport = new ReplayTransport([{ id: "A" }, { id: "B" }], () => clock.now());
    const room = makeRoom(store, transport, clock);
    await room.start();
    const say = async (i: number) => {
      clock.advanceSeconds(5);
      await transport.deliver(i % 2 ? "A" : "B", `Layout note ${i} filed for section ${i}.`);
      await room.idle();
    };
    for (let i = 0; i < 20; i++) await say(i);
    const at20 = coreSize(path);
    for (let i = 20; i < 200; i++) await say(i);
    const at200 = coreSize(path);

    assert.equal(at200.hasMessages, false);
    assert.equal(at200.m, 200);
    // Ten times the messages, but the core snapshot barely grows.
    assert.ok(at200.bytes < at20.bytes * 1.5, `core grew from ${at20.bytes} to ${at200.bytes} bytes`);

    const before = JSON.stringify(room.state.toJSON());
    store.close();
    const reopened = new SqliteStore(path);
    const again = makeRoom(reopened, new ReplayTransport([{ id: "A" }, { id: "B" }], () => clock.now()), clock);
    await again.start();
    assert.equal(JSON.stringify(again.state.toJSON()), before);
    reopened.close();
  });

  it("migrates a room saved as one full snapshot", async () => {
    const path = join(dir, "legacy.db");
    // Write the old format: messages and transitions inside state_json.
    {
      const s0 = new SqliteStore(path); // creates the schema
      s0.close();
      const clock = new VirtualClock();
      const t = new ReplayTransport([{ id: "A" }], () => clock.now());
      const tmp = new ChorusRoom({ transport: t, extractor: new HeuristicExtractor(), confirmer: new HeuristicConfirmer(), clock, config: defaultConfig });
      await tmp.start();
      await t.deliver("A", "Does the API support refunds?");
      await tmp.idle();
      const db = new DatabaseSync(path);
      db.prepare("INSERT INTO rooms VALUES ('rom_i', 1, ?, '2026-01-01T00:00:00Z')").run(JSON.stringify(tmp.state.toJSON()));
      db.close();
    }
    const store = new SqliteStore(path);
    const clock = new VirtualClock(new Date("2026-01-01T00:10:00Z"));
    const transport = new ReplayTransport([{ id: "A" }, { id: "B" }], () => clock.now());
    const room = makeRoom(store, transport, clock);
    await room.start();
    assert.equal(room.state.questions.get("Q1")!.status, "open");
    // A fresh replay transport numbers from msg_1 again, which the room has
    // already seen (and correctly skips as a redelivery); use the next ID.
    await transport.deliver("A", "Does the API support refunds?");
    await transport.deliver("B", "Yes. Refunds are supported.");
    await room.idle();
    store.close();

    const size = coreSize(path);
    assert.equal(size.hasMessages, false, "migrated to the append-only format");
    assert.equal(size.m, 2);
    const reopened = new SqliteStore(path);
    const loaded = reopened.load("rom_i")!;
    assert.equal((loaded.state as { messages: unknown[] }).messages.length, 2);
    reopened.close();
  });

  it("retention blanks stored message text too", async () => {
    const path = join(dir, "retention.db");
    const store = new SqliteStore(path);
    const clock = new VirtualClock();
    const transport = new ReplayTransport([{ id: "A" }], () => clock.now());
    const room = makeRoom(store, transport, clock);
    await room.start();
    await transport.deliver("A", "A secret-ish old message.");
    await room.idle();
    clock.advanceSeconds(8 * 86_400); // past the 7-day retention
    await room.tick();
    await room.idle();
    store.close();
    const reopened = new SqliteStore(path);
    const msgs = (reopened.load("rom_i")!.state as { messages: Array<{ text: string; seq: number }> }).messages;
    assert.equal(msgs[0]!.text, "");
    assert.equal(msgs[0]!.seq, 1, "the stub stays, so citations still resolve");
    reopened.close();
  });
});
