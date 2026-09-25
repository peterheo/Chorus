// npm run bench [-- <db path>]   (N=4000 by default; set N to change)
//
// Per-message processing cost as a room grows: a synthetic room of N
// messages (commitments, questions, claims and chatter from three agents),
// SQLite persistence, heuristic extractor, facilitate mode. Prints the
// average ms/message for each block of 1,000 messages.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChorusRoom } from "../src/chorus.ts";
import { VirtualClock } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { HeuristicConfirmer } from "../src/confirm.ts";
import { HeuristicExtractor } from "../src/extract/heuristic.ts";
import { SqliteStore } from "../src/store.ts";
import { ReplayTransport } from "../src/transport/replay.ts";

const path = process.argv[2] ?? join(mkdtempSync(join(tmpdir(), "chorus-bench-")), "bench.db");
rmSync(path, { force: true });
const total = Number(process.env.N ?? 4000);

const store = new SqliteStore(path);
const clock = new VirtualClock();
const transport = new ReplayTransport([{ id: "A" }, { id: "B" }, { id: "C" }], () => clock.now());
const room = new ChorusRoom({
  transport,
  store,
  roomKey: "bench",
  extractor: new HeuristicExtractor(),
  confirmer: new HeuristicConfirmer(),
  clock,
  config: { ...defaultConfig, mode: "facilitate" },
});
await room.start();

const text = (i: number) =>
  [`I'll check item ${i}.`, `Does item ${i} support refunds?`, `Item ${i} is supported.`, `Layout note ${i} filed.`][i % 4]!;

let last = performance.now();
for (let i = 1; i <= total; i++) {
  clock.advanceSeconds(3);
  await transport.deliver(["A", "B", "C"][i % 3]!, text(i));
  if (i % 1000 === 0 || i === total) {
    await room.idle();
    const now = performance.now();
    const block = i % 1000 === 0 ? 1000 : i % 1000;
    console.log(`messages ${i - block + 1}-${i}: ${((now - last) / block).toFixed(2)} ms/message`);
    last = now;
  }
}
store.close();
