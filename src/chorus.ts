// The per-room pipeline (spec §11): receive → normalize → dedupe → pre-filter
// → extract → apply → rules → policy → post. All work for a room runs on one
// serial queue, so state is only ever touched by one step at a time.

import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import { COMMAND, runCommand } from "./commands.ts";
import type { ChorusConfig } from "./config.ts";
import type { Confirmer } from "./confirm.ts";
import type { Extractor, ExtractionContext } from "./extract/types.ts";
import { InterventionPolicy } from "./policy.ts";
import { completion, conflicts, duplicateWork, unansweredQuestions, type RuleContext } from "./rules/rules.ts";
import { applyEvents } from "./state/engine.ts";
import { RoomState } from "./state/room.ts";
import type { InterventionCandidate, Message } from "./state/types.ts";
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
  /** trace sink for the replay harness and logs */
  onEvent?: (e: ChorusEvent) => void;
}

/** Messages that cannot carry an obligation (spec §11.2 pre-filter). */
const TRIVIAL = /^(ok(ay)?|k|thanks?( you)?|thx|ty|cool|nice|great|sounds good|lgtm|\+1|👍|🙏|yes|no|sure)[.!]*$/i;

export class ChorusRoom {
  readonly state: RoomState;
  private readonly policy: InterventionPolicy;
  private queue: Promise<void> = Promise.resolve();
  private readonly completionAnnounced = { value: false };
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ChorusOptions) {
    this.state = new RoomState(opts.config.mode);
    this.policy = new InterventionPolicy(() => opts.config);
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
    const t = this.opts.transport;
    await t.connect();
    this.state.chorusAgentId = t.selfId();
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
    return this.enqueue(() => this.evaluate("tick"));
  }

  private ensureAgent(id: string, name?: string): void {
    const now = this.opts.clock.now().toISOString();
    const a = this.state.agents.get(id);
    if (a) {
      if (name && a.displayName === id) a.displayName = name;
      return;
    }
    this.state.agents.set(id, {
      id,
      displayName: name ?? id,
      aliases: [],
      firstSeenAt: now,
      lastSeenAt: now,
      lastRoomIndex: 0,
    });
  }

  private async ingest(ext: ExternalRoomMessage): Promise<void> {
    const s = this.state;
    if (s.messageIds.has(ext.id)) {
      this.emit({ kind: "skip", seq: ext.seq, detail: `duplicate delivery of ${ext.id}` });
      return;
    }
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
    if (isFromChorus) return;
    if (ext.type && ext.type !== "message") {
      this.emit({ kind: "skip", seq: msg.seq, detail: `non-message type ${ext.type}` });
      return;
    }
    this.emit({ kind: "message", seq: msg.seq, detail: `${s.agentName(msg.authorId)}: ${msg.text}` });

    if (COMMAND.test(msg.text)) {
      const r = runCommand(s, msg, this.opts.clock.now());
      this.emit({ kind: "command", seq: msg.seq, detail: msg.text.trim() });
      await this.post(
        {
          type: "completion_check",
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
      return;
    }

    if (TRIVIAL.test(msg.text.trim()) && !msg.replyToId) {
      this.emit({ kind: "skip", seq: msg.seq, detail: "pre-filter: trivial" });
      await this.evaluate("state_change");
      return;
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
  }

  private context(msg: Message): ExtractionContext {
    const s = this.state;
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
      ].slice(0, 20),
    };
  }

  private async evaluate(trigger: "state_change" | "tick"): Promise<void> {
    const s = this.state;
    const ctx: RuleContext = { config: this.opts.config, confirmer: this.opts.confirmer, now: this.opts.clock.now() };
    // §17.1: unanswered is time-based but also checked on messages, since its
    // message-count threshold is crossed by a message arriving.
    const candidates: InterventionCandidate[] = [
      ...unansweredQuestions(s, ctx),
      ...(trigger === "state_change"
        ? [...(await duplicateWork(s, ctx)), ...conflicts(s, ctx)]
        : completion(s, ctx, this.completionAnnounced)),
    ];
    const decision = this.policy.choose(s, candidates, ctx.now);
    for (const { candidate, reason } of decision.suppressed) {
      this.emit({ kind: "suppressed", detail: `${candidate.type} ${candidate.relatedObjectIds.join(",")}: ${reason}` });
    }
    if (decision.post) await this.post(decision.post, false);
  }

  private async post(c: InterventionCandidate, solicited: boolean): Promise<void> {
    const s = this.state;
    const now = this.opts.clock.now();
    // Record before sending: a crash mid-send retries with the same key (§35).
    const record = { candidate: c, postedAt: now.toISOString(), postedIndex: s.roomIndex, solicited, messageId: undefined as string | undefined };
    s.posted.push(record);
    if (c.type === "unanswered_question") {
      for (const id of c.relatedObjectIds) {
        const q = s.questions.get(id);
        if (q) q.lastSurfacedIndex = s.roomIndex;
      }
    }
    if (c.type === "completion_check" && !solicited) this.completionAnnounced.value = true;
    if (s.mode === "observe" && !solicited) return;
    const result = await this.opts.transport.sendMessage({
      text: c.text,
      replyToId: c.replyToMessageId,
      idempotencyKey: randomUUID(),
    });
    record.messageId = result.id;
    this.emit({ kind: "posted", seq: result.seq, detail: `${solicited ? "reply" : c.type}\n${c.text}` });
  }
}
