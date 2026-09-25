// The per-room pipeline (spec §11): receive → normalize → dedupe → pre-filter
// → extract → apply → rules → policy → post → commit. All work for a room runs
// on one serial queue, so state is only ever touched by one step at a time.

import { createHash } from "node:crypto";
import type { Clock } from "./clock.ts";
import { COMMAND, runCommand } from "./commands.ts";
import type { ChorusConfig } from "./config.ts";
import type { Confirmer } from "./confirm.ts";
import type { Extractor, ExtractionContext } from "./extract/types.ts";
import type { ExtractedEvent } from "./schemas/llm.ts";
import { transitionEvent, type RoomEvent } from "./api/views.ts";
import { InterventionPolicy } from "./policy.ts";
import {
  completion,
  completionReport,
  conflicts,
  duplicateWork,
  decisionReminders,
  dependencyDeadlocks,
  missingAcknowledgements,
  repeatedQuestions,
  resolvedDependencies,
  staleCommitments,
  unansweredQuestions,
  type RuleContext,
} from "./rules/rules.ts";
import { applyDeadlines, applyEvents, settle } from "./state/engine.ts";
import { RoomState } from "./state/room.ts";
import type { InterventionCandidate, Message } from "./state/types.ts";
import type { LlmCall } from "./extract/claude.ts";
import { agentBrief } from "./insights.ts";
import { endExpiredSession, settleOrders } from "./operations.ts";
import { ReceiptSigner } from "./receipts.ts";
import { MemoryStore, type InterventionRow, type MessageRow, type ReceiptRow, type Store } from "./store.ts";
import type { ExternalRoomMessage, RoomTransport } from "./transport/types.ts";

export interface ChorusEvent {
  kind: "message" | "events" | "state" | "candidate" | "suppressed" | "posted" | "command" | "skip" | "error";
  seq?: number;
  detail: string;
}

export interface ChorusOptions {
  transport: RoomTransport;
  extractor: Extractor;
  confirmer: Confirmer;
  clock: Clock;
  config: ChorusConfig;
  /** where state is committed after every message; defaults to memory only */
  store?: Store;
  /** key for this room in the store (the SharedNet room ID in live use) */
  roomKey?: string;
  /** trace sink for the replay harness and logs */
  onEvent?: (e: ChorusEvent) => void;
  /** signs receipts (§54); an ephemeral key is generated if omitted */
  signer?: ReceiptSigner;
  /** used when the primary (LLM) extractor is over its call budget (§63) */
  fallbackExtractor?: Extractor;
  /**
   * §78 facilitator election: announce this instance on start and speak only
   * while it is the lowest online Chorus instance ID in the room.
   */
  election?: boolean;
}

/** Without transport presence, a silent peer counts as gone after this long. */
const PEER_STALE_MS = 30 * 60_000;

/** A Chorus instance announcing itself for §78 election. */
const PRESENCE = /^\[chorus\] online as (\S+)/;

/** "I'm the verifier." / "This is Verifier." / "Hi, I am ResearchA" — the whole message. */
// No /i flag: the second branch must really start with a capital letter, so
// "I'm stuck." or "This is wrong." is never taken for a name.
const SELF_ID =
  /^(?:(?:[Hh]i|[Hh]ello|[Hh]ey)[,!]?\s+)?(?:I'm|i'm|I am|i am|[Tt]his is)\s+(?:[Tt]he\s+([a-z][\w-]{1,30})|([A-Z][\w-]{1,30}))(?:\s+agent)?\s*[.!]?$/;
const NOT_A_NAME = new Set(
  "done back here ready sure not on in out busy free online working checking looking going sorry fine ok okay available new late".split(" "),
);

/** Messages that cannot carry an obligation (spec §11.2 pre-filter). */
const TRIVIAL = /^(ok(ay)?|k|thanks?( you)?|thx|ty|cool|nice|great|sounds good|lgtm|\+1|👍|🙏|yes|no|sure)[.!]*$/i;

/**
 * Deterministic UUID v4-shaped key for an intervention (spec §35). If Chorus
 * crashes after posting but before committing, re-processing produces the same
 * candidate and the same key, and SharedNet returns the stored message instead
 * of posting it twice.
 */
export function interventionKey(roomKey: string, selfId: string, candidateKey: string): string {
  const h = createHash("sha256").update(`${roomKey}\u0000${selfId}\u0000${candidateKey}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class ChorusRoom {
  private _state: RoomState;
  private readonly policy: InterventionPolicy;
  private readonly store: Store;
  private readonly roomKey: string;
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  /** interventions posted since the last commit */
  private pending: InterventionRow[] = [];
  /** receipts issued since the last commit */
  private pendingReceipts: ReceiptRow[] = [];
  readonly signer: ReceiptSigner;
  /** start times of recent LLM extraction calls, for the §63 budget */
  private llmWindow: number[] = [];
  private lastPruneAt = 0;
  private lastRosterAt = 0;
  private lastPaymentPollAt = 0;
  /** a welcome-back brief for the author of the message being processed (§78) */
  private pendingBrief: InterventionCandidate | null = null;
  /** messages received but not yet processed (§11.2) */
  private inbox: Array<{ ext: ExternalRoomMessage; done: () => void; fail: (err: unknown) => void }> = [];
  private readonly listeners = new Set<(e: RoomEvent) => void>();
  /** transitions already published to subscribers */
  private published = 0;

  constructor(private readonly opts: ChorusOptions) {
    this.store = opts.store ?? new MemoryStore();
    this.roomKey = opts.roomKey ?? "room";
    this._state = new RoomState(opts.config.mode);
    this.policy = new InterventionPolicy(() => opts.config);
    this.signer = opts.signer ?? ReceiptSigner.load({});
  }

  /** Record one LLM request: metrics (§59) and the raw-response log (§48). */
  recordLlmCall(call: LlmCall): void {
    const s = this._state;
    s.count("llm_calls");
    if (call.inputTokens) s.count("llm_input_tokens", call.inputTokens);
    if (call.outputTokens) s.count("llm_output_tokens", call.outputTokens);
    this.store.logLlmCall?.(this.roomKey, call);
  }

  /** §63: pick the extractor for the next message, respecting the per-minute budget. */
  private chooseExtractor(): Extractor {
    const primary = this.opts.extractor;
    const fallback = this.opts.fallbackExtractor;
    if (!fallback || primary.name === "heuristic") return primary;
    const now = this.opts.clock.now().getTime();
    this.llmWindow = this.llmWindow.filter((t) => now - t < 60_000);
    if (this.llmWindow.length >= this.opts.config.llm.maxCallsPerMinute) {
      this._state.count("llm_budget_fallbacks");
      return fallback;
    }
    this.llmWindow.push(now);
    return primary;
  }

  /** §65: prune message text past the retention period, at most hourly. Returns how many were pruned. */
  private prune(): number {
    const now = this.opts.clock.now();
    if (now.getTime() - this.lastPruneAt < 3_600_000) return 0;
    this.lastPruneAt = now.getTime();
    const cutoff = new Date(now.getTime() - this.opts.config.retention.days * 86_400_000).toISOString();
    const n = this._state.prune(cutoff);
    this.store.prune?.(this.roomKey, cutoff);
    if (n) this.emit({ kind: "state", detail: `retention: pruned text of ${n} messages older than ${cutoff}` });
    return n;
  }

  get state(): RoomState {
    return this._state;
  }

  /** Receive state-change events as they are committed (§32). Returns an unsubscribe function. */
  subscribe(listener: (e: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Committed events after `lastId` (exclusive), for SSE Last-Event-ID resume. */
  eventsSince(lastId: number): RoomEvent[] {
    const out: RoomEvent[] = [];
    const t = this._state.transitions;
    // Only up to what has been published: later transitions are not durable
    // yet and will reach subscribers through commit().
    for (let i = Math.max(0, lastId + 1); i < this.published; i++) {
      const e = transitionEvent(this._state, t[i]!, i);
      if (e) out.push(e);
    }
    return out;
  }

  private emit(e: ChorusEvent): void {
    this.opts.onEvent?.(e);
  }

  /** Run `fn` after everything already queued for this room. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn).catch((err) => {
      this.emit({ kind: "error", detail: (err as Error).stack ?? String(err) });
    });
    this.queue = run;
    return run;
  }

  /**
   * Run one unit of work (a message or a tick) so that an unexpected error
   * leaves no trace: state rolls back to exactly what it was before, and
   * nothing uncommitted is kept. The error is rethrown.
   */
  private async atomically<T>(fn: () => Promise<T>): Promise<T> {
    const before = JSON.stringify(this._state.toJSON());
    try {
      return await fn();
    } catch (err) {
      this._state = RoomState.fromJSON(JSON.parse(before));
      this.pending = [];
      this.pendingReceipts = [];
      throw err;
    }
  }

  /** Resolves once all queued work (including self-echoes) has been handled. */
  async idle(): Promise<void> {
    let before: Promise<void>;
    do {
      before = this.queue;
      await before;
      await new Promise((r) => setImmediate(r)); // let deferred echoes enqueue
    } while (before !== this.queue);
  }

  async start(opts: { tick?: boolean } = {}): Promise<void> {
    const saved = this.store.load(this.roomKey);
    if (saved) {
      this._state = RoomState.fromJSON(saved.state);
      this.published = this._state.transitions.length;
      this.emit({
        kind: "state",
        detail: `restored ${this.roomKey} at #${saved.lastProcessedSeq} (mode ${this._state.mode})`,
      });
    }
    const t = this.opts.transport;
    await t.connect();
    this._state.chorusAgentId = t.selfId();
    await this.refreshRoster();
    // The handler resolves only once the message is processed, so the
    // transport never advances its cursor past unprocessed messages.
    // If processing fails, the promise rejects and the transport redelivers.
    t.onMessage(
      (m) =>
        new Promise<void>((done, fail) => {
          this.inbox.push({ ext: m, done, fail });
          void this.enqueue(() => this.drain());
        }),
    );
    if (opts.tick) {
      this.timer = setInterval(() => void this.tick(), this.opts.config.tickSeconds * 1000);
    }
    if (this.opts.election) {
      const self = this._state.chorusAgentId!;
      await this.enqueue(async () => {
        await this.post(
          this.reply(
            `presence:${self}:${this.opts.clock.now().toISOString()}`,
            `[chorus] online as ${self}. With several Chorus instances in a room, only the lowest online instance ID speaks; the others keep state and take over if it goes offline.`,
            [],
          ),
          true,
          true,
        );
        this.commit();
      });
    }
  }

  private async refreshRoster(): Promise<void> {
    this.lastRosterAt = this.opts.clock.now().getTime();
    for (const r of await this.opts.transport.roster()) {
      this.ensureAgent(r.id, r.name);
      const a = this._state.agents.get(r.id)!;
      if (r.presence) a.presence = r.presence;
    }
  }

  /** §78: am I the instance that speaks? Always true without election. */
  isSpeaker(): boolean {
    if (!this.opts.election) return true;
    const s = this._state;
    const self = s.chorusAgentId!;
    const now = this.opts.clock.now().getTime();
    const online = [...s.chorusPeers.keys()].filter((id) => {
      const a = s.agents.get(id);
      if (a?.presence !== undefined) return a.presence === "online";
      // Unknown presence (the transport does not report it): assume online
      // only while the peer has been seen recently.
      return a !== undefined && now - Date.parse(a.lastSeenAt) < PEER_STALE_MS;
    });
    return [self, ...online].sort()[0] === self;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.idle();
    await this.opts.transport.close();
  }

  tick(): Promise<void> {
    return this.enqueue(() => this.atomically(() => this.runTick()));
  }

  private async runTick(): Promise<void> {
    {
      const now = this.opts.clock.now();
      const before = { transitions: this._state.transitions.length, posted: this._state.posted.length };
      const ordersBefore = JSON.stringify(this._state.orders.map((o) => o.status));
      const expired = applyDeadlines(this._state, now);
      for (const id of expired) this.emit({ kind: "state", detail: `${id} → ${this._state.object(id)?.status} (deadline)` });
      if (this.opts.election && now.getTime() - this.lastRosterAt >= 60_000) await this.refreshRoster();
      const sessionEnd = endExpiredSession(this._state, this.roomKey, now, this.signer);
      if (sessionEnd) {
        this.pendingReceipts.push(sessionEnd.record);
        await this.post(this.reply(`session-end:${sessionEnd.record.sha256}`, sessionEnd.text, [this._state.session?.requestedBy ?? ""]), true);
      }
      await this.checkPayments(now);
      const pruned = this.prune();
      await this.evaluate("tick");
      const s = this._state;
      const changed =
        s.transitions.length !== before.transitions ||
        s.posted.length !== before.posted ||
        this.pending.length > 0 ||
        pruned > 0 ||
        sessionEnd !== null ||
        JSON.stringify(this._state.orders.map((o) => o.status)) !== ordersBefore;
      if (changed) this.commit();
    }
  }

  /**
   * §43: while orders await payment, poll received credit transfers (at most
   * every 20 s) and run what was paid for. Also expires unpaid orders.
   */
  private async checkPayments(now: Date): Promise<void> {
    const s = this._state;
    const payments = this.opts.transport.payments;
    if (!payments || !s.orders.some((o) => o.status === "awaiting_payment")) return;
    if (now.getTime() - this.lastPaymentPollAt < 20_000) return;
    this.lastPaymentPollAt = now.getTime();
    let transfers;
    try {
      transfers = await payments.receivedTransfers();
    } catch (err) {
      this.emit({ kind: "error", detail: `could not read credit transfers: ${(err as Error).message}` });
      return;
    }
    for (const done of settleOrders(s, transfers, this.roomKey, now, this.signer)) {
      this.emit({ kind: "state", detail: `${done.order.id} paid by ${done.order.payment!.transferId}` });
      const messageId = await this.post(
        this.reply(`order:${done.order.id}`, done.text, [done.order.requestedBy], done.order.requestMessageId),
        true,
      );
      if (done.receipt) {
        done.receipt.messageId = messageId;
        this.pendingReceipts.push(done.receipt);
      }
    }
  }

  /** A solicited reply (command answers, receipts): exempt from rate limits. */
  private reply(key: string, text: string, involved: string[], replyToMessageId?: string): InterventionCandidate {
    return {
      type: "command_reply",
      severity: "low",
      involvedAgentIds: involved.filter(Boolean),
      relatedObjectIds: [],
      evidenceMessageIds: replyToMessageId ? [replyToMessageId] : [],
      confidence: 1,
      urgency: 1,
      expectedValue: 1,
      blockedAgents: 0,
      idempotencyKey: key,
      text,
      replyToMessageId,
      createdIndex: this._state.roomIndex,
    };
  }

  /**
   * §12.1: learn an alias only from explicit self-identification ("I'm the
   * verifier", "This is Verifier"), and never one another agent already uses.
   */
  private learnAlias(msg: Message): void {
    const m = SELF_ID.exec(msg.text.trim());
    if (!m) return;
    const alias = (m[1] ?? m[2])!;
    if (NOT_A_NAME.has(alias.toLowerCase())) return;
    const s = this._state;
    const taken = [...s.agents.values()].some(
      (a) =>
        a.id !== msg.authorId &&
        (a.displayName.toLowerCase() === alias.toLowerCase() || a.aliases.some((x) => x.toLowerCase() === alias.toLowerCase())),
    );
    const agent = s.agents.get(msg.authorId)!;
    if (taken || agent.aliases.includes(alias) || agent.displayName.toLowerCase() === alias.toLowerCase()) return;
    agent.aliases.push(alias);
    // Guest seats have no display name; the first self-introduction becomes it.
    if (agent.displayName === agent.id) agent.displayName = alias;
    this.emit({ kind: "state", seq: msg.seq, detail: `${agent.id} is also known as "${alias}"` });
  }

  private commit(message?: MessageRow): void {
    const s = this._state;
    const complete = completionReport(s).complete && s.transitions.some((t) => t.kind !== "room");
    if (complete !== s.readyToClose) {
      s.readyToClose = complete;
      s.record({
        objectId: "room",
        kind: "room",
        from: complete ? "active" : "ready_to_close",
        to: complete ? "ready_to_close" : "active",
        cause: message ? "event" : "tick",
        messageId: message?.externalId,
        at: this.opts.clock.now().toISOString(),
      });
    }
    this.store.commit(this.roomKey, {
      seq: this._state.lastProcessedSeq,
      state: this._state.toJSON(),
      message,
      interventions: this.pending,
      receipts: this.pendingReceipts,
    });
    this.pending = [];
    this.pendingReceipts = [];
    // Publish only after the state is durable.
    const t = s.transitions;
    for (; this.published < t.length; this.published++) {
      const e = transitionEvent(s, t[this.published]!, this.published);
      if (e) for (const l of this.listeners) l(e);
    }
  }

  private ensureAgent(id: string, name?: string): void {
    const now = this.opts.clock.now().toISOString();
    const a = this._state.agents.get(id);
    if (a) {
      if (name && a.displayName === id) a.displayName = name;
      return;
    }
    this._state.agents.set(id, {
      id,
      displayName: name ?? id,
      aliases: [],
      firstSeenAt: now,
      lastSeenAt: now,
      lastRoomIndex: 0,
    });
  }

  /** Would this message go to the extractor? (mirrors the early exits in process) */
  private extractable(ext: ExternalRoomMessage): boolean {
    const s = this._state;
    return (
      !s.messageIds.has(ext.id) &&
      ext.authorId !== s.chorusAgentId &&
      (!ext.type || ext.type === "message") &&
      !COMMAND.test(ext.text) &&
      !PRESENCE.test(ext.text) &&
      !(TRIVIAL.test(ext.text.trim()) && !ext.replyToId)
    );
  }

  /**
   * Process everything in the inbox. §11.2: when the backlog is large and the
   * extractor can batch, extract several messages in one call against the
   * current state, then apply each in sequence order as usual.
   */
  private async drain(): Promise<void> {
    const batch = this.inbox.splice(0);
    if (batch.length === 0) return;
    const cfg = this.opts.config.extraction;
    const pre = new Map<string, ExtractedEvent[]>();
    if (batch.length > cfg.batchWhenBacklogOver && this.opts.extractor.extractBatch) {
      const c = this._state.counters;
      c.set("extraction_backlog_max", Math.max(c.get("extraction_backlog_max") ?? 0, batch.length));
      const todo = batch.map((b) => b.ext).filter((e) => this.extractable(e));
      for (let i = 0; i < todo.length; i += cfg.maxBatch) {
        const chunk = todo.slice(i, i + cfg.maxBatch);
        // Each batch call counts against the §63 budget like a single call.
        const extractor = this.chooseExtractor();
        if (!extractor.extractBatch) continue; // over budget: per-message fallback below
        {
          try {
            const results = await extractor.extractBatch(
              chunk.map((e) => ({ text: e.text, ctx: this.context(this.previewMessage(e)) })),
            );
            chunk.forEach((e, j) => pre.set(e.id, results[j] ?? []));
            this._state.count("extraction_batches");
            this.emit({ kind: "events", detail: `batch-extracted ${chunk.length} messages (#${chunk[0]!.seq}–#${chunk.at(-1)!.seq})` });
          } catch (err) {
            // Fall back to one call per message below.
            this.emit({ kind: "error", detail: `batch extraction failed: ${(err as Error).message}` });
          }
        }
      }
    }
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i]!;
      try {
        await this.atomically(() => this.ingest(b.ext, pre.get(b.ext.id)));
        b.done();
      } catch (err) {
        // Nothing from this message was kept. Reject it and everything after
        // it, in order, so the transport redelivers them all.
        this.emit({ kind: "error", seq: b.ext.seq, detail: `processing failed, will be redelivered: ${(err as Error).message}` });
        for (const rest of batch.slice(i)) rest.fail(err);
        return;
      }
    }
  }

  /** §78: an agent returning after a long absence gets a brief of what changed. */
  private welcomeBack(msg: Message): InterventionCandidate | null {
    const s = this._state;
    const a = s.agents.get(msg.authorId)!;
    if (!a.prevRoomIndex) return null; // first message: nothing to catch up on
    const cfg = this.opts.config.brief;
    const awayMessages = s.roomIndex - a.prevRoomIndex - 1;
    const awayMinutes = a.prevSeenAt ? (Date.parse(msg.timestamp) - Date.parse(a.prevSeenAt)) / 60_000 : 0;
    if (awayMessages < cfg.minAbsentMessages && awayMinutes < cfg.minAbsentMinutes) return null;
    const lines = agentBrief(s, a.id, a.prevRoomIndex, a.prevSeenAt ?? "");
    if (lines.length === 0) return null;
    return {
      type: "agent_brief",
      severity: "medium",
      involvedAgentIds: [a.id],
      relatedObjectIds: [],
      evidenceMessageIds: [msg.id],
      confidence: 0.95,
      urgency: 0.7,
      expectedValue: 0.9,
      blockedAgents: 0,
      idempotencyKey: `agent_brief:${a.id}:${msg.id}`,
      text: [`Welcome back, ${s.agentName(a.id)}. Since you were last active (${awayMessages} messages ago):`, "", ...lines.map((l) => `- ${l}`)].join("\n"),
      replyToMessageId: msg.id,
      createdIndex: s.roomIndex,
    };
  }

  /** A Message view of an unprocessed message, for building extraction context. */
  private previewMessage(ext: ExternalRoomMessage): Message {
    return {
      id: ext.id,
      seq: ext.seq,
      roomIndex: 0,
      authorId: ext.authorId,
      text: ext.text,
      timestamp: ext.timestamp,
      replyToId: ext.replyToId,
      isFromChorus: false,
    };
  }

  private async ingest(ext: ExternalRoomMessage, preExtracted?: ExtractedEvent[]): Promise<void> {
    const s = this._state;
    if (s.messageIds.has(ext.id)) {
      this.emit({ kind: "skip", seq: ext.seq, detail: `duplicate delivery of ${ext.id}` });
      return;
    }
    const processingState = await this.process(ext, preExtracted);
    s.lastProcessedSeq = Math.max(s.lastProcessedSeq, ext.seq);
    this.commit({
      externalId: ext.id,
      seq: ext.seq,
      authorId: ext.authorId,
      text: ext.text,
      timestamp: ext.timestamp,
      isFromChorus: ext.authorId === s.chorusAgentId,
      processingState,
    });
  }

  private async process(ext: ExternalRoomMessage, preExtracted?: ExtractedEvent[]): Promise<MessageRow["processingState"]> {
    const s = this._state;
    s.messageIds.add(ext.id);
    this.ensureAgent(ext.authorId, ext.authorName);

    const isFromChorus = ext.authorId === s.chorusAgentId;
    if (!isFromChorus) s.roomIndex++;
    const msg: Message = {
      id: ext.id,
      seq: ext.seq,
      roomIndex: isFromChorus ? 0 : s.roomIndex,
      authorId: ext.authorId,
      text: ext.text,
      timestamp: ext.timestamp,
      replyToId: ext.replyToId,
      isFromChorus,
    };
    s.messages.push(msg);
    const agent = s.agents.get(ext.authorId)!;
    if (!isFromChorus) {
      agent.prevRoomIndex = agent.lastRoomIndex;
      agent.prevSeenAt = agent.lastSeenAt;
      agent.lastRoomIndex = s.roomIndex;
    }
    agent.lastSeenAt = ext.timestamp;

    // §11.1: Chorus's own messages are stored but never extracted or counted.
    if (isFromChorus) return "own";
    if (ext.type && ext.type !== "message") {
      this.emit({ kind: "skip", seq: msg.seq, detail: `non-message type ${ext.type}` });
      return "skipped";
    }
    this.emit({ kind: "message", seq: msg.seq, detail: `${s.agentName(msg.authorId)}: ${msg.text}` });
    const peer = PRESENCE.exec(msg.text);
    if (peer) {
      // Another Chorus instance: remember it for election, never extract from it.
      s.chorusPeers.set(msg.authorId, msg.timestamp);
      this.emit({ kind: "state", seq: msg.seq, detail: `Chorus peer ${msg.authorId}; speaker is ${this.isSpeaker() ? "this instance" : "another instance"}` });
      return "skipped";
    }
    this.learnAlias(msg);
    this.pendingBrief = this.welcomeBack(msg);

    if (COMMAND.test(msg.text)) {
      const r = runCommand(s, msg, {
        now: this.opts.clock.now(),
        room: this.roomKey,
        signer: this.signer,
        operations: this.opts.config.operations,
        howToPay: this.opts.transport.payments?.howToPay,
      });
      this.emit({ kind: "command", seq: msg.seq, detail: msg.text.trim() });
      const messageId = await this.post(this.reply(`command:${msg.id}`, r.reply, [msg.authorId], msg.id), true);
      if (r.receipt) {
        r.receipt.messageId = messageId;
        this.pendingReceipts.push(r.receipt);
      }
      if (r.changed) {
        // e.g. "@chorus resolved C3" releases agents waiting on C3.
        for (const id of settle(s, msg, this.opts.clock.now())) {
          this.emit({ kind: "state", seq: msg.seq, detail: `${id} → ${s.object(id)?.status}` });
        }
        await this.evaluate("state_change");
      }
      return "command";
    }

    if (TRIVIAL.test(msg.text.trim()) && !msg.replyToId) {
      this.emit({ kind: "skip", seq: msg.seq, detail: "pre-filter: trivial" });
      await this.evaluate("state_change");
      return "skipped";
    }

    const extractor = preExtracted ? this.opts.extractor : this.chooseExtractor();
    let events;
    try {
      events = preExtracted ?? (await extractor.extract(msg.text, this.context(msg)));
    } catch (err) {
      if ((err as Error).name !== "ExtractionFailedError") throw err;
      s.count("extraction_failures");
      this.emit({ kind: "error", seq: msg.seq, detail: (err as Error).message });
      await this.evaluate("state_change");
      return "extraction_failed";
    }
    this.emit({
      kind: "events",
      seq: msg.seq,
      detail: events.length ? events.map((e) => e.type).join(", ") : "(none)",
    });
    const result = await applyEvents(s, msg, events, {
      config: this.opts.config,
      confirmer: this.opts.confirmer,
      now: this.opts.clock.now(),
      lexicalExtractor: extractor.name === "heuristic",
      log: (d) => this.emit({ kind: "state", seq: msg.seq, detail: d }),
    });
    for (const id of result.created) this.emit({ kind: "state", seq: msg.seq, detail: `created ${id}` });
    for (const id of result.changed) {
      this.emit({ kind: "state", seq: msg.seq, detail: `${id} → ${s.object(id)?.status}` });
    }
    await this.evaluate("state_change");
    return "applied";
  }

  private context(msg: Message): ExtractionContext {
    const s = this._state;
    const recent = s.messages
      .filter((m) => !m.isFromChorus && m.id !== msg.id)
      .slice(-this.opts.config.extraction.recentWindow)
      .map((m) => ({ seq: m.seq, author: s.agentName(m.authorId), text: m.text }));
    const reply = msg.replyToId ? s.message(msg.replyToId) : undefined;
    return {
      author: s.agentName(msg.authorId),
      replyTo: reply ? { author: s.agentName(reply.authorId), text: reply.text } : undefined,
      recent,
      roster: [...s.agents.values()].filter((a) => a.id !== s.chorusAgentId).map((a) => a.displayName),
      openObjects: [
        ...s.openQuestions().map((q) => ({ id: q.id, summary: q.text, owner: s.agentName(q.askerId) })),
        ...s.activeCommitments().map((c) => ({ id: c.id, summary: c.action, owner: s.agentName(c.ownerId) })),
        ...s.pendingHandoffs().map((h) => ({ id: h.id, summary: h.action, owner: s.agentName(h.toAgentId) })),
      ].slice(0, 20),
    };
  }

  private async evaluate(trigger: "state_change" | "tick"): Promise<void> {
    const s = this._state;
    const ctx: RuleContext = { config: this.opts.config, confirmer: this.opts.confirmer, now: this.opts.clock.now() };
    // §17.1: count-based thresholds are crossed by a message arriving, so the
    // time-based rules also run on state changes; completion is tick-only.
    const candidates: InterventionCandidate[] = [
      ...unansweredQuestions(s, ctx),
      ...missingAcknowledgements(s, ctx),
      ...staleCommitments(s, ctx),
      // Deadlines expire on ticks, which can resolve dependencies.
      ...resolvedDependencies(s, ctx),
      ...dependencyDeadlocks(s, ctx),
      ...(trigger === "state_change"
        ? [
            ...(await duplicateWork(s, ctx)),
            ...conflicts(s, ctx),
            ...repeatedQuestions(s, ctx),
            ...decisionReminders(s, ctx),
            ...(this.pendingBrief ? [this.pendingBrief] : []),
          ]
        : completion(s, ctx)),
    ];
    this.pendingBrief = null;
    const decision = this.policy.choose(s, candidates, ctx.now);
    for (const { candidate, reason } of decision.suppressed) {
      this.emit({ kind: "suppressed", detail: `${candidate.type} ${candidate.relatedObjectIds.join(",")}: ${reason}` });
    }
    if (decision.post) await this.post(decision.post, false);
  }

  private async post(c: InterventionCandidate, solicited: boolean, always = false): Promise<string | undefined> {
    const s = this._state;
    const now = this.opts.clock.now();
    const record = {
      candidate: c,
      postedAt: now.toISOString(),
      postedIndex: s.roomIndex,
      solicited,
      messageId: undefined as string | undefined,
    };
    const silent = (s.mode === "observe" && !solicited) || (!always && !this.isSpeaker());
    // Deterministic key (§35), fixed before anything can change posted.length.
    const key = interventionKey(this.roomKey, s.chorusAgentId ?? "", `${c.idempotencyKey}#${s.posted.length + 1}`);
    let result: { id: string; seq: number } | undefined;
    if (!silent) {
      // Send first: a failed send throws before anything is recorded, so the
      // intervention is retried rather than counted as delivered.
      result = await this.opts.transport.sendMessage({ text: c.text, replyToId: c.replyToMessageId, idempotencyKey: key });
    }
    s.posted.push(record);
    // Mark every surfaced object, including ones absorbed by merging (§51).
    for (const id of c.relatedObjectIds) {
      const o = s.questions.get(id) ?? s.commitments.get(id) ?? s.handoffs.get(id);
      if (o && c.type !== "command_reply") o.lastSurfacedIndex = s.roomIndex;
    }
    if (c.type === "completion_check") s.completionAnnounced = true;
    for (const key of [c.idempotencyKey, ...(c.absorbedKeys ?? [])]) {
      if (key.startsWith("dependency_resolved:")) {
        const p = s.dependencies.get(key.split(":")[1]!);
        if (p) p.notified = true;
      }
    }
    // Observe mode and standby instances (§78) record what they would have
    // said, so it is not repeated later, but stay silent.
    if (!result) {
      if (!always && !this.isSpeaker()) {
        this.emit({ kind: "suppressed", detail: `${c.type}: standby (another Chorus instance is speaking)` });
      }
      return undefined;
    }
    record.messageId = result.id;
    this.pending.push({
      key,
      type: c.type,
      text: c.text,
      solicited,
      outputMessageId: result.id,
      postedAt: record.postedAt,
    });
    this.emit({ kind: "posted", seq: result.seq, detail: `${solicited ? "reply" : c.type}\n${c.text}` });
    return result.id;
  }
}
