// SharedNet V1 transport (spec §34.1). Uses the raw HTTP API: a long-poll
// `GET /rooms/{id}/wait` loop for ingest and `POST /rooms/{id}/messages` with
// an Idempotency-Key for output. The CLI `wait` is not used because it skips
// the caller's own posts.

import type {
  ExternalRoomMessage,
  OutboundMessage,
  RoomTransport,
  RosterEntry,
  SendResult,
  TransportCapabilities,
} from "./types.ts";

export interface SharedNetConfig {
  baseUrl: string; // e.g. https://www.sharednet.ai
  roomId: string; // rom_…
  /** seat/instance token (sni_…) for room routes */
  token: string;
  /** start after this sequence (last_processed_seq); 0 replays full history */
  after?: number;
  log?: (msg: string) => void;
}

interface ApiMessage {
  id: string;
  room_id: string;
  sequence: number;
  sender_instance_id: string;
  sender?: { member_id: string; kind: string; name: string | null };
  type?: string;
  content: string;
  reply_to_message_id: string | null;
  created_at: string;
}

interface Page {
  items: ApiMessage[];
  next_cursor: string | null;
  has_more: boolean;
}

export class SharedNetTransport implements RoomTransport {
  private handler: ((m: ExternalRoomMessage) => Promise<void>) | null = null;
  private cursor: number;
  private self = "";
  private running = false;
  private loop: Promise<void> | null = null;
  private abort = new AbortController();

  constructor(private readonly cfg: SharedNetConfig) {
    this.cursor = cfg.after ?? 0;
  }

  capabilities(): TransportCapabilities {
    return {
      sequenceNumbers: true,
      orderedDelivery: true,
      replyReferences: true,
      mentions: false,
      presence: true,
      history: true,
      edits: false,
      deletes: false,
      selfEcho: true,
    };
  }

  selfId(): string {
    if (!this.self) throw new Error("SharedNetTransport: selfId() before connect()");
    return this.self;
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, "")}/api/v1${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.cfg.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.abort.signal,
      });
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || res.status >= 500;
      const text = await res.text();
      if (!retryable || attempt >= 4) {
        throw new Error(`SharedNet ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      }
      const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
      this.cfg.log?.(`SharedNet ${res.status}, retrying in ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
    }
  }

  async connect(): Promise<void> {
    const me = await this.request<{ instance: { id: string } }>("GET", "/instances/current");
    this.self = me.instance.id;
    this.running = true;
    this.loop = this.waitLoop();
  }

  onMessage(callback: (m: ExternalRoomMessage) => Promise<void>): void {
    this.handler = callback;
  }

  private toExternal(m: ApiMessage): ExternalRoomMessage {
    return {
      id: m.id,
      seq: m.sequence,
      authorId: m.sender_instance_id,
      authorName: m.sender?.name ?? undefined,
      text: m.content,
      timestamp: m.created_at,
      replyToId: m.reply_to_message_id ?? undefined,
      type: m.type ?? "message",
    };
  }

  private async waitLoop(): Promise<void> {
    while (this.running) {
      try {
        const page = await this.request<Page>(
          "GET",
          `/rooms/${this.cfg.roomId}/wait?after=${this.cursor}&limit=100&timeout=25`,
        );
        // Hand the whole page over at once, so a backlog can be batch-extracted
        // (§11.2); the room still processes it in sequence order. Advance the
        // cursor only once every message in the page has been processed. If
        // one fails, the page is fetched again; processed ones are deduped.
        await Promise.all(page.items.map((item) => this.handler?.(this.toExternal(item))));
        for (const item of page.items) this.cursor = Math.max(this.cursor, item.sequence);
      } catch (err) {
        if (!this.running) return;
        this.cfg.log?.(`SharedNet wait failed: ${(err as Error).message}; retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async sendMessage(out: OutboundMessage): Promise<SendResult> {
    const body: Record<string, unknown> = { content: out.text };
    if (out.replyToId) body.reply_to_message_id = out.replyToId;
    const res = await this.request<{ message: ApiMessage }>(
      "POST",
      `/rooms/${this.cfg.roomId}/messages`,
      body,
      out.idempotencyKey,
    );
    return { id: res.message.id, seq: res.message.sequence };
  }

  async roster(): Promise<RosterEntry[]> {
    // Membership field names are not published in the OpenAPI schema; read
    // defensively and fall back to IDs (README: "Names").
    const res = await this.request<{ memberships?: Array<Record<string, unknown>> }>(
      "GET",
      `/rooms/${this.cfg.roomId}`,
    );
    const out: RosterEntry[] = [];
    for (const m of res.memberships ?? []) {
      const id = (m.instance_id ?? m.member_id ?? m.id) as string | undefined;
      const name = (m.name ?? m.display_name ?? m.handle) as string | undefined;
      const presence = typeof m.presence === "string" ? m.presence : undefined;
      if (id) out.push({ id, ...(name ? { name } : {}), ...(presence ? { presence } : {}) });
    }
    return out;
  }

  async close(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loop?.catch(() => {});
  }
}
