// The per-room pipeline (spec §11): receive → normalize → dedupe → pre-filter
// → extract → apply → rules → policy → post → commit. All work for a room runs
// on one serial queue, so state is only ever touched by one step at a time.

import { createHash } from "node:crypto";
import type { Clock } from "./clock.ts";
import { COMMAND, runCommand } from "./commands.ts";
import type { ChorusConfig } from "./config.ts";
import type { Confirmer } from "./confirm.ts";
import type { Extractor, ExtractionContext } from "./extract/types.ts";
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
import { applyDeadlines, applyEvents } from "./state/engine.ts";
import { RoomState } from "./state/room.ts";
import type { InterventionCandidate, Message } from "./state/types.ts";
import { MemoryStore, type InterventionRow, type MessageRow, type Store } from "./store.ts";
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
}

/** "I'm the verifier." / "This is Verifier." / "Hi, I am ResearchA" — the whole message. */
const SELF_ID =
  /^(?:(?:hi|hello|hey)[,!]?\s+)?(?:i'm|i am|this is)\s+(?:the\s+([a-z][\w-]{1,30})|([A-Z][\w-]{1,30}))(?:\s+agent)?\s*[.!]?$/i;
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
  private readonly listeners = new Set<(e: RoomEvent) => void>();
  /** transitions already published to subscribers */
  private published = 0;

  constructor(private readonly opts: ChorusOptions) {
    this.store = opts.store ?? new MemoryStore();
    this.roomKey = opts.roomKey ?? "room";
    this._state = new RoomState(opts.config.mode);
    this.policy = new InterventionPolicy(() => opts.config);
  }

  get state(): RoomState {
    return this._state;
  }

  /** Receive state-change events as they are committed (§32). Returns an unsubscribe function. */
  subscribe(listener: (e: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after `lastId` (exclusive), for SSE Last-Event-ID resume. */
  eventsSince(lastId: number): RoomEvent[] {
    const out: RoomEvent[] = [];
    const t = this._state.transitions;
    for (let i = Math.max(0, lastId + 1); i < t.length; i++) {
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
    for (const r of await t.roster()) this.ensureAgent(r.id, r.name);
    t.onMessage((m) => this.enqueue(() => this.ingest(m)));
    if (opts.tick) {
      this.timer = setInterval(() => void this.tick(), this.opts.config.tickSeconds * 1000);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.idle();
    await this.opts.transport.close();
  }

  tick(): Promise<void> {
    return this.enqueue(async () => {
      const expired = applyDeadlines(this._state, this.opts.clock.now());
      for (const id of expired) this.emit({ kind: "state", detail: `${id} → ${this._state.object(id)?.status} (deadline)` });
      await this.evaluate("tick");
      if (this.pending.length || expired.length) this.commit();
    });
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
    if (taken || agent.aliases.includes(alias)) return;
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
    });
    this.pending = [];
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

  private async ingest(ext: ExternalRoomMessage): Promise<void> {
    const s = this._state;
    if (s.messageIds.has(ext.id)) {
      this.emit({ kind: "skip", seq: ext.seq, detail: `duplicate delivery of ${ext.id}` });
      return;
    }
    const processingState = await this.process(ext);
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

  private async process(ext: ExternalRoomMessage): Promise<MessageRow["processingState"]> {
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
    agent.lastSeenAt = ext.timestamp;
    if (!isFromChorus) agent.lastRoomIndex = s.roomIndex;

    // §11.1: Chorus's own messages are stored but never extracted or counted.
    if (isFromChorus) return "own";
    if (ext.type && ext.type !== "message") {
      this.emit({ kind: "skip", seq: msg.seq, detail: `non-message type ${ext.type}` });
      return "skipped";
    }
    this.emit({ kind: "message", seq: msg.seq, detail: `${s.agentName(msg.authorId)}: ${msg.text}` });
    this.learnAlias(msg);

    if (COMMAND.test(msg.text)) {
      const r = runCommand(s, msg, this.opts.clock.now());
      this.emit({ kind: "command", seq: msg.seq, detail: msg.text.trim() });
      await this.post(
        {
          type: "command_reply",
          severity: "low",
          involvedAgentIds: [msg.authorId],
          relatedObjectIds: [],
          evidenceMessageIds: [msg.id],
          confidence: 1,
          urgency: 1,
          expectedValue: 1,
          blockedAgents: 0,
          idempotencyKey: `command:${msg.id}`,
          text: r.reply,
          replyToMessageId: msg.id,
          createdIndex: s.roomIndex,
        },
        true,
      );
      if (r.changed) await this.evaluate("state_change");
      return "command";
    }

    if (TRIVIAL.test(msg.text.trim()) && !msg.replyToId) {
      this.emit({ kind: "skip", seq: msg.seq, detail: "pre-filter: trivial" });
      await this.evaluate("state_change");
      return "skipped";
    }

    const events = await this.opts.extractor.extract(msg.text, this.context(msg));
    this.emit({
      kind: "events",
      seq: msg.seq,
      detail: events.length ? events.map((e) => e.type).join(", ") : "(none)",
    });
    const result = await applyEvents(s, msg, events, {
      config: this.opts.config,
      confirmer: this.opts.confirmer,
      now: this.opts.clock.now(),
      lexicalExtractor: this.opts.extractor.name === "heuristic",
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
          ]
        : completion(s, ctx)),
    ];
    const decision = this.policy.choose(s, candidates, ctx.now);
    for (const { candidate, reason } of decision.suppressed) {
      this.emit({ kind: "suppressed", detail: `${candidate.type} ${candidate.relatedObjectIds.join(",")}: ${reason}` });
    }
    if (decision.post) await this.post(decision.post, false);
  }

  private async post(c: InterventionCandidate, solicited: boolean): Promise<void> {
    const s = this._state;
    const now = this.opts.clock.now();
    const record = {
      candidate: c,
      postedAt: now.toISOString(),
      postedIndex: s.roomIndex,
      solicited,
      messageId: undefined as string | undefined,
    };
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
    if (s.mode === "observe" && !solicited) return;

    const key = interventionKey(this.roomKey, s.chorusAgentId ?? "", `${c.idempotencyKey}#${s.posted.length}`);
    const result = await this.opts.transport.sendMessage({ text: c.text, replyToId: c.replyToMessageId, idempotencyKey: key });
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
  }
}
