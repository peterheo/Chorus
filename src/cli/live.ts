// npm start — run Chorus against a live SharedNet room.
//
// Configuration (spec §73):
//   SHAREDNET_BASE_URL   default https://www.sharednet.ai
//   SHAREDNET_ROOM       rom_…
//   SHAREDNET_TOKEN      seat token (sni_…), or
//   SHAREDNET_SEAT_FILE  path to a seat file written by `sharednet join`
//                        (~/.config/sharednet/rooms/<room>/<member>.json)
//   CHORUS_MODE          observe | assist (default) | facilitate
//   CHORUS_EXTRACTOR     heuristic (default) | claude
//   LLM_MODEL            model for the claude extractor (default claude-opus-5)
//
// Flags:
//   --after N            start after sequence N (default: the room's latest
//                        message, so history is not re-announced)

import { readFileSync } from "node:fs";
import { ChorusRoom } from "../chorus.ts";
import { SystemClock } from "../clock.ts";
import { defaultConfig, type Mode } from "../config.ts";
import { HeuristicConfirmer } from "../confirm.ts";
import { ClaudeConfirmer, ClaudeExtractor } from "../extract/claude.ts";
import { HeuristicExtractor } from "../extract/heuristic.ts";
import { SharedNetTransport } from "../transport/sharednet.ts";

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const env = process.env;
let baseUrl = env.SHAREDNET_BASE_URL ?? "https://www.sharednet.ai";
let roomId = env.SHAREDNET_ROOM;
let token = env.SHAREDNET_TOKEN;

if (!token && env.SHAREDNET_SEAT_FILE) {
  const seat = JSON.parse(readFileSync(env.SHAREDNET_SEAT_FILE, "utf8")) as {
    base_url?: string;
    room_id?: string;
    member_token?: string;
  };
  token = seat.member_token;
  roomId ??= seat.room_id;
  if (!env.SHAREDNET_BASE_URL && seat.base_url) baseUrl = seat.base_url;
}
if (!roomId) fail("Set SHAREDNET_ROOM (or SHAREDNET_SEAT_FILE).");
if (!token) fail("Set SHAREDNET_TOKEN or SHAREDNET_SEAT_FILE.");

const mode = (env.CHORUS_MODE ?? "assist") as Mode;
if (!["observe", "assist", "facilitate"].includes(mode)) fail(`Bad CHORUS_MODE ${mode}`);

const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);

async function latestSequence(): Promise<number> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/rooms/${roomId}/messages?order=desc&limit=1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) fail(`Could not read room ${roomId}: ${res.status} ${await res.text()}`);
  const page = (await res.json()) as { items: Array<{ sequence: number }> };
  return page.items[0]?.sequence ?? 0;
}

const afterIdx = process.argv.indexOf("--after");
const after = afterIdx >= 0 ? Number(process.argv[afterIdx + 1]) : await latestSequence();

const useClaude = env.CHORUS_EXTRACTOR === "claude";
const transport = new SharedNetTransport({ baseUrl, roomId, token, after, log });
const room = new ChorusRoom({
  transport,
  extractor: useClaude ? new ClaudeExtractor({ model: env.LLM_MODEL, log }) : new HeuristicExtractor(),
  confirmer: useClaude ? new ClaudeConfirmer({ model: env.LLM_MODEL, log }) : new HeuristicConfirmer(),
  clock: new SystemClock(),
  config: { ...defaultConfig, mode },
  onEvent: (e) => {
    if (e.kind === "suppressed" || e.kind === "skip") return;
    log(`${e.seq !== undefined ? `#${e.seq} ` : ""}${e.kind}: ${e.detail.replace(/\n/g, " ⏎ ")}`);
  },
});

await room.start({ tick: true });
log(`Chorus listening in ${roomId} as ${transport.selfId()} (mode ${mode}, extractor ${useClaude ? "claude" : "heuristic"}, after #${after})`);

const shutdown = async () => {
  log("shutting down");
  await room.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
