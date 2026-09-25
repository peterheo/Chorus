// Replay transport + fixture format (spec §47). The harness in replay.ts
// drives delivery and the virtual clock; this class only moves messages.

import { z } from "zod";
import type {
  ExternalRoomMessage,
  OutboundMessage,
  RoomTransport,
  RosterEntry,
  SendResult,
  TransportCapabilities,
} from "./types.ts";

export const FixtureSchema = z.object({
  room: z.string(),
  description: z.string().optional(),
  mode: z.enum(["observe", "assist", "facilitate"]).optional(),
  agents: z.array(z.object({ id: z.string(), display_name: z.string().optional() })),
  messages: z.array(
    z.object({
      /** offset from fixture start, e.g. "+5s"; defaults to previous + default_spacing */
      t: z.string().optional(),
      agent: z.string(),
      text: z.string(),
      /** 0-based index into `messages` this one replies to */
      reply_to: z.number().int().optional(),
      /** re-deliver this message (duplicate delivery test, §35) */
      deliver_twice: z.boolean().optional(),
    }),
  ),
  default_spacing: z.string().optional(),
  advance_clock_to: z.string().optional(),
});
export type Fixture = z.infer<typeof FixtureSchema>;

export function parseOffset(s: string): number {
  const m = /^\+?(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s.trim());
  if (!m) throw new Error(`Bad time offset "${s}" (expected e.g. "+5s", "+2m")`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return unit === "ms" ? n : unit === "m" ? n * 60_000 : n * 1000;
}

export const CHORUS_REPLAY_ID = "chorus";

export class ReplayTransport implements RoomTransport {
  private handler: ((m: ExternalRoomMessage) => Promise<void>) | null = null;
  private seq = 0;
  readonly log: ExternalRoomMessage[] = [];
  readonly sent: ExternalRoomMessage[] = [];
  private readonly sentKeys = new Map<string, SendResult>();

  constructor(
    private readonly agents: RosterEntry[],
    private readonly now: () => Date,
  ) {}

  capabilities(): TransportCapabilities {
    return {
      sequenceNumbers: true,
      orderedDelivery: true,
      replyReferences: true,
      mentions: false,
      presence: false,
      history: true,
      edits: false,
      deletes: false,
      selfEcho: true,
    };
  }

  selfId(): string {
    return CHORUS_REPLAY_ID;
  }

  async connect(): Promise<void> {}

  onMessage(callback: (m: ExternalRoomMessage) => Promise<void>): void {
    this.handler = callback;
  }

  async roster(): Promise<RosterEntry[]> {
    return [...this.agents, { id: CHORUS_REPLAY_ID, name: "Chorus" }];
  }

  /** Deliver an agent message; returns the stored message. */
  async deliver(authorId: string, text: string, replyToId?: string): Promise<ExternalRoomMessage> {
    const m: ExternalRoomMessage = {
      id: `msg_${++this.seq}`,
      seq: this.seq,
      authorId,
      authorName: this.agents.find((a) => a.id === authorId)?.name ?? authorId,
      text,
      timestamp: this.now().toISOString(),
      replyToId,
      type: "message",
    };
    this.log.push(m);
    await this.handler?.(m);
    return m;
  }

  /** Re-deliver an already-delivered message unchanged (duplicate delivery). */
  async redeliver(m: ExternalRoomMessage): Promise<void> {
    await this.handler?.(m);
  }

  async sendMessage(out: OutboundMessage): Promise<SendResult> {
    const existing = this.sentKeys.get(out.idempotencyKey);
    if (existing) return existing;
    const m: ExternalRoomMessage = {
      id: `msg_${++this.seq}`,
      seq: this.seq,
      authorId: CHORUS_REPLAY_ID,
      authorName: "Chorus",
      text: out.text,
      timestamp: this.now().toISOString(),
      replyToId: out.replyToId,
      type: "message",
    };
    this.log.push(m);
    this.sent.push(m);
    const result = { id: m.id, seq: m.seq };
    this.sentKeys.set(out.idempotencyKey, result);
    // Self-echo like SharedNet history: Chorus sees its own message come back.
    // Deferred so the pipeline's serial queue handles it after the current step.
    queueMicrotask(() => void this.handler?.(m)?.catch(() => {}));
    return result;
  }

  async close(): Promise<void> {}
}
