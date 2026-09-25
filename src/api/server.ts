// HTTP state API and SSE event stream (spec §31, §32, §41) on node:http.
// Every route needs `Authorization: Bearer <token>` (§31 Authentication).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ChorusRoom } from "../chorus.ts";
import { metrics } from "../metrics.ts";
import { agentContextView, decisionsView, historyView, openItemsView, stateView } from "./views.ts";

export interface ApiOptions {
  /** rooms served, keyed by room ID (the SharedNet rom_… ID in live use) */
  rooms: Map<string, ChorusRoom>;
  token: string;
  /** SSE keep-alive comment interval */
  heartbeatMs?: number;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1]!);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const ROUTE =
  /^\/v1\/rooms\/([^/]+)(?:\/(state|open-items|decisions|events|metrics|receipts|agents\/([^/]+)\/context|objects\/([^/]+)\/history))?\/?$/;
const KEY_ROUTE = /^\/v1\/keys\/([^/]+)\/?$/;

export function createApiServer(opts: ApiOptions): Server {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET") return send(res, 405, { error: { code: "method_not_allowed" } });
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });

    // Public keys are public: anyone holding a receipt must be able to verify it (§54).
    const k = KEY_ROUTE.exec(url.pathname);
    if (k) {
      const keyId = decodeURIComponent(k[1]!);
      const signer = [...opts.rooms.values()].map((r) => r.signer).find((s) => s.keyId === keyId);
      return signer
        ? send(res, 200, { key_id: keyId, algorithm: "Ed25519", public_key_pem: signer.publicKeyPem })
        : send(res, 404, { error: { code: "key_not_found" } });
    }

    if (!authorized(req, opts.token)) return send(res, 401, { error: { code: "authentication_required" } });

    const m = ROUTE.exec(url.pathname);
    if (!m) return send(res, 404, { error: { code: "route_not_found" } });
    const [, roomId, view, agentId, objectId] = m;
    const room = opts.rooms.get(decodeURIComponent(roomId!));
    if (!room) return send(res, 404, { error: { code: "room_not_found" } });
    const s = room.state;

    if (!view || view === "state") return send(res, 200, stateView(roomId!, s));
    if (view === "open-items") return send(res, 200, openItemsView(s));
    if (view === "decisions") return send(res, 200, decisionsView(s));
    if (view === "metrics") return send(res, 200, metrics(s));
    if (view === "receipts") return send(res, 200, { receipts: s.receipts });
    if (agentId !== undefined) return send(res, 200, agentContextView(s, decodeURIComponent(agentId)));
    if (objectId !== undefined) {
      const h = historyView(s, decodeURIComponent(objectId).toUpperCase());
      return h ? send(res, 200, h) : send(res, 404, { error: { code: "object_not_found" } });
    }

    // view === "events": SSE (§32). Resume with Last-Event-ID or ?after=.
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const resume = req.headers["last-event-id"] ?? url.searchParams.get("after");
    const write = (e: { id: number; event: string; sequence: number | null; data: unknown }) =>
      res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify({ sequence: e.sequence, ...(e.data as object) })}\n\n`);
    if (resume !== undefined && resume !== null && resume !== "") {
      for (const e of room.eventsSince(Number(resume))) write(e);
    }
    res.write(": connected\n\n");
    const unsubscribe = room.subscribe(write);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
