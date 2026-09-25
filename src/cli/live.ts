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
//   CHORUS_DB            SQLite file for room state (default .chorus/chorus.db)
//   CHORUS_API_PORT      serve the state API + SSE (spec §31–32) on this port
//   CHORUS_API_TOKEN     bearer token for the API (generated and printed if unset)
//   RECEIPT_SIGNING_KEY  Ed25519 private key (PKCS#8 PEM) for receipts; default:
//                        generated once and kept in .chorus/receipt-key.pem
//   RECEIPT_KEY_ID       key ID shown on receipts (default derived from the key)
//
// Flags:
//   --after N            start after sequence N. Default: where the saved
//                        state left off, or the room's latest message on a
//                        first run (so history is not re-announced).

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createApiServer } from "../api/server.ts";
import { ChorusRoom } from "../chorus.ts";
import { SystemClock } from "../clock.ts";
import { defaultConfig, type Mode } from "../config.ts";
import { HeuristicConfirmer } from "../confirm.ts";
import { ClaudeConfirmer, ClaudeExtractor } from "../extract/claude.ts";
import { HeuristicExtractor } from "../extract/heuristic.ts";
import { ReceiptSigner } from "../receipts.ts";
import { SqliteStore } from "../store.ts";
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

const dbPath = env.CHORUS_DB ?? ".chorus/chorus.db";
mkdirSync(dirname(dbPath), { recursive: true });
const store = new SqliteStore(dbPath);
const saved = store.load(roomId);

const afterIdx = process.argv.indexOf("--after");
const after =
  afterIdx >= 0 ? Number(process.argv[afterIdx + 1]) : saved ? saved.lastProcessedSeq : await latestSequence();

const useClaude = env.CHORUS_EXTRACTOR === "claude";
const transport = new SharedNetTransport({ baseUrl, roomId, token, after, log });
const signer = ReceiptSigner.load({
  pem: env.RECEIPT_SIGNING_KEY,
  path: `${dirname(dbPath)}/receipt-key.pem`,
  keyId: env.RECEIPT_KEY_ID,
});
// LLM calls are logged to SQLite and counted (§48, §59); `room` is assigned below.
const claudeOpts = { model: env.LLM_MODEL, log, onCall: (c: Parameters<ChorusRoom["recordLlmCall"]>[0]) => room.recordLlmCall(c) };
const room: ChorusRoom = new ChorusRoom({
  transport,
  signer,
  extractor: useClaude ? new ClaudeExtractor(claudeOpts) : new HeuristicExtractor(),
  fallbackExtractor: useClaude ? new HeuristicExtractor() : undefined,
  confirmer: useClaude ? new ClaudeConfirmer(claudeOpts) : new HeuristicConfirmer(),
  clock: new SystemClock(),
  config: { ...defaultConfig, mode },
  store,
  roomKey: roomId,
  onEvent: (e) => {
    if (e.kind === "suppressed" || e.kind === "skip") return;
    log(`${e.seq !== undefined ? `#${e.seq} ` : ""}${e.kind}: ${e.detail.replace(/\n/g, " ⏎ ")}`);
  },
});

await room.start({ tick: true });
log(`Chorus listening in ${roomId} as ${transport.selfId()} (mode ${mode}, extractor ${useClaude ? "claude" : "heuristic"}, after #${after})`);
log(`Receipts signed with key ${signer.keyId}`);

const apiPort = env.CHORUS_API_PORT ? Number(env.CHORUS_API_PORT) : undefined;
const api =
  apiPort === undefined
    ? undefined
    : (() => {
        const apiToken = env.CHORUS_API_TOKEN ?? randomBytes(24).toString("base64url");
        const server = createApiServer({ rooms: new Map([[roomId, room]]), token: apiToken });
        server.listen(apiPort, () => {
          log(`State API on http://localhost:${apiPort}/v1/rooms/${roomId}/state`);
          if (!env.CHORUS_API_TOKEN) log(`API token (set CHORUS_API_TOKEN to fix it): ${apiToken}`);
        });
        return server;
      })();

const shutdown = async () => {
  log("shutting down");
  api?.close();
  await room.stop();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
