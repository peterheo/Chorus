// Deterministic state engine (spec §15, §16). Extractors propose events; only
// this module changes state, and every change is recorded as a transition.

import type { ChorusConfig } from "../config.ts";
import type { Confirmer } from "../confirm.ts";
import type { ExtractedEvent } from "../schemas/llm.ts";
import { conditionsOverlap, contentTokens, overlap, textSimilarity } from "../similarity.ts";
import type { RoomState } from "./room.ts";
import type { Claim, Commitment, Conflict, Handoff, Message, ObjectKind, Question } from "./types.ts";

export interface ApplyContext {
  config: ChorusConfig;
  confirmer: Confirmer;
  now: Date;
  /** true when the extractor is rule-based: every event is a lexical match (§40) */
  lexicalExtractor: boolean;
  log?: (msg: string) => void;
}

export interface ApplyResult {
  created: string[];
  changed: string[];
  newConflicts: string[];
}

/** Resolve a name as written in a message to an agent ID (spec §12.1). */
export function resolveAgent(state: RoomState, name: string): string | null {
  const n = name.replace(/^@/, "").toLowerCase();
  const agents = [...state.agents.values()];
  const exact = agents.find(
    (a) => a.id.toLowerCase() === n || a.displayName.toLowerCase() === n || a.aliases.some((x) => x.toLowerCase() === n),
  );
  if (exact) return exact.id;
  const prefix = agents.filter((a) => a.displayName.toLowerCase().startsWith(n));
  return prefix.length === 1 ? prefix[0]!.id : null;
}

function transition(
  state: RoomState,
  kind: ObjectKind,
  obj: { id: string; status: string },
  to: string,
  msg: Message | undefined,
  now: Date,
  cause: "event" | "tick" | "command" | "feedback" = "event",
): void {
  const from = obj.status;
  if (from === to) return;
  obj.status = to;
  if (kind === "commitment") touch(state, obj as Commitment, now);
  state.record({ objectId: obj.id, kind, from, to, cause, messageId: msg?.id, at: now.toISOString() });
}

/** Record that the owner updated a commitment (feeds §21 staleness). */
function touch(state: RoomState, c: Commitment, now: Date): void {
  c.updatedIndex = state.roomIndex;
  c.updatedAt = now.toISOString();
}

function created(state: RoomState, kind: ObjectKind, id: string, status: string, msg: Message, now: Date): void {
  state.record({ objectId: id, kind, from: null, to: status, cause: "event", messageId: msg.id, at: now.toISOString() });
}

/** §40 confidence bands. */
function admissible(e: ExtractedEvent, msg: Message, events: ExtractedEvent[], ctx: ApplyContext): boolean {
  const t = ctx.config.thresholds;
  if (e.confidence >= t.extractionAutoApply) return true;
  if (e.confidence < t.extractionCorroborated) {
    ctx.log?.(`#${msg.seq}: ${e.type} at ${e.confidence.toFixed(2)} kept as candidate only`);
    return false;
  }
  const corroborated =
    ctx.lexicalExtractor || msg.replyToId !== undefined || e.target_agents.length > 0 || events.length > 1;
  if (!corroborated) ctx.log?.(`#${msg.seq}: ${e.type} at ${e.confidence.toFixed(2)} not corroborated`);
  return corroborated;
}

function latestActiveCommitment(state: RoomState, ownerId: string, action?: string | null): Commitment | undefined {
  const mine = state.activeCommitments().filter((c) => c.ownerId === ownerId);
  if (mine.length === 0) return undefined;
  if (action) {
    const best = mine
      .map((c) => ({ c, s: textSimilarity(c.action, action) }))
      .sort((a, b) => b.s - a.s)[0]!;
    if (best.s >= 0.5) return best.c;
  }
  return mine[mine.length - 1];
}

/** Claimed by a commitment that is still live. */
export function isClaimed(state: RoomState, q: Question): boolean {
  const c = q.claimedByCommitmentId ? state.commitments.get(q.claimedByCommitmentId) : undefined;
  return !!c && ["proposed", "accepted", "in_progress", "blocked"].includes(c.status);
}

function newCommitment(
  state: RoomState,
  msg: Message,
  e: ExtractedEvent,
  action: string,
  conditional: boolean,
  now: Date,
  fromHandoffId?: string,
): Commitment {
  const c: Commitment = {
    id: state.nextId("commitment"),
    ownerId: msg.authorId,
    sourceMessageId: msg.id,
    action,
    status: conditional ? "proposed" : "in_progress",
    optional: conditional,
    fromHandoffId,
    createdAt: now.toISOString(),
    createdIndex: state.roomIndex,
    updatedIndex: state.roomIndex,
    updatedAt: now.toISOString(),
    derivedFromMessageIds: [msg.id],
    extractorConfidence: e.confidence,
  };
  state.commitments.set(c.id, c);
  created(state, "commitment", c.id, c.status, msg, now);
  // A commitment that takes on an open, unclaimed question or request claims
  // it, so §18 never offers it as "still unclaimed" work.
  for (const q of state.openQuestions()) {
    if (!isClaimed(state, q) && q.askerId !== msg.authorId) {
      const addressedToMe = q.targetIds.length === 0 || q.targetIds.includes(msg.authorId);
      if (addressedToMe && textSimilarity(q.text, action) >= 0.6) {
        q.claimedByCommitmentId = c.id;
        break;
      }
    }
  }
  return c;
}

/**
 * The pending handoff a message from its recipient refers to: the one it
 * replies to, else one whose action matches, else the only one pending.
 */
function handoffFor(state: RoomState, msg: Message, action?: string | null): Handoff | undefined {
  const mine = state.pendingHandoffs().filter((h) => h.toAgentId === msg.authorId);
  if (mine.length === 0) return undefined;
  if (msg.replyToId) {
    const direct = mine.find((h) => h.sourceMessageId === msg.replyToId);
    if (direct) return direct;
  }
  if (action) {
    const best = mine
      .map((h) => ({ h, s: textSimilarity(h.action, action) }))
      .sort((a, b) => b.s - a.s)[0]!;
    if (best.s >= 0.5) return best.h;
  }
  return mine.length === 1 ? mine[0] : undefined;
}

/** §16.3: accepting a handoff creates the recipient's commitment; that commitment is then the live object. */
function acceptHandoff(state: RoomState, h: Handoff, msg: Message, e: ExtractedEvent, now: Date): Commitment {
  h.acknowledgementMessageId = msg.id;
  h.derivedFromMessageIds.push(msg.id);
  transition(state, "handoff", h, "accepted", msg, now);
  const c = newCommitment(state, msg, e, h.action, false, now, h.id);
  h.resultingCommitmentId = c.id;
  return c;
}

/** Accepted handoffs mirror their commitment's terminal state (§16.3). */
function syncHandoffs(state: RoomState, msg: Message, now: Date): string[] {
  const changed: string[] = [];
  for (const h of state.handoffs.values()) {
    if (h.status !== "accepted" || !h.resultingCommitmentId) continue;
    const c = state.commitments.get(h.resultingCommitmentId);
    if (c?.status === "completed") transition(state, "handoff", h, "completed", msg, now);
    else if (c?.status === "cancelled") transition(state, "handoff", h, "cancelled", msg, now);
    else continue;
    changed.push(h.id);
  }
  return changed;
}

/** Which open question (if any) does this claim or answer resolve? (§15) */
function questionAnswered(state: RoomState, msg: Message, claim: Claim | null): Question | undefined {
  const candidates = state.openQuestions().filter((q) => q.askerId !== msg.authorId);
  if (candidates.length === 0) return undefined;
  // Steps 1–3 of §14: a direct reply to the question's message.
  if (msg.replyToId) {
    const direct = candidates.find((q) => q.sourceMessageId === msg.replyToId);
    if (direct) return direct;
  }
  if (!claim) return undefined;
  const claimTokens = contentTokens(`${claim.subject} ${claim.predicate}`);
  const scored = candidates
    .map((q) => ({ q, s: overlap(claimTokens, contentTokens(q.text)) }))
    .sort((a, b) => b.s - a.s);
  const best = scored[0]!;
  const second = scored[1];
  // Relevance threshold, and unambiguous: no other question within 0.05.
  if (best.s < 0.8) return undefined;
  if (second && best.s - second.s < 0.05) return undefined;
  return best.q;
}

function answer(state: RoomState, q: Question, msg: Message, now: Date): void {
  q.answerMessageIds.push(msg.id);
  q.derivedFromMessageIds.push(msg.id);
  q.resolvedAt = now.toISOString();
  transition(state, "question", q, "answered", msg, now);
  // Answering a question you had committed to look into completes that
  // commitment (spec §12.2: "Checked X. It works." is completion + answer).
  const mine = state.activeCommitments().filter((c) => c.ownerId === msg.authorId && !c.optional);
  const match = mine.find((c) => q.claimedByCommitmentId === c.id) ??
    mine
      .map((c) => ({ c, s: textSimilarity(c.action, q.text) }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s)[0]?.c;
  if (match) {
    match.completionMessageId = msg.id;
    match.derivedFromMessageIds.push(msg.id);
    transition(state, "commitment", match, "completed", msg, now);
  }
}

async function linkConflicts(state: RoomState, claim: Claim, msg: Message, ctx: ApplyContext): Promise<string[]> {
  const t = ctx.config.thresholds;
  const newConflicts: string[] = [];
  const subject = contentTokens(claim.subject);
  const others = state
    .activeClaims()
    .filter(
      (k) =>
        k.id !== claim.id &&
        k.agentId !== claim.agentId &&
        overlap(subject, contentTokens(k.subject)) >= t.conflictSubject &&
        conditionsOverlap(k.conditions, claim.conditions),
    );

  for (const other of others) {
    const existing = state
      .unresolvedConflicts()
      .find((x) => x.claimIds.includes(other.id) || overlap(subject, contentTokens(x.subject)) >= t.conflictSubject);
    if (existing?.claimIds.includes(claim.id)) continue;

    const verdict = await ctx.confirmer.conflict(other, claim);
    if (verdict.verdict !== "conflict") continue;

    const status: Conflict["status"] =
      verdict.confidence >= t.conflictConfidence && !claim.hedged && !other.hedged ? "confirmed" : "candidate";

    if (existing) {
      // Group: a third claim joins the existing conflict (§10.5).
      existing.claimIds.push(claim.id);
      existing.derivedFromMessageIds.push(msg.id);
      if (existing.status === "candidate" && status === "confirmed") {
        existing.confirmConfidence = verdict.confidence;
        transition(state, "conflict", existing, "confirmed", msg, ctx.now);
        newConflicts.push(existing.id);
      }
    } else {
      const x: Conflict = {
        id: state.nextId("conflict"),
        subject: other.subject,
        claimIds: [other.id, claim.id],
        status,
        resolutionMessageIds: [],
        confirmConfidence: verdict.confidence,
        createdAt: ctx.now.toISOString(),
        createdIndex: state.roomIndex,
        derivedFromMessageIds: [other.messageId, msg.id],
        extractorConfidence: Math.min(other.extractorConfidence, claim.extractorConfidence),
      };
      state.conflicts.set(x.id, x);
      created(state, "conflict", x.id, x.status, msg, ctx.now);
      if (status === "confirmed") newConflicts.push(x.id);
    }
  }
  return newConflicts;
}

/** A conflict resolves once its remaining active claims no longer disagree. */
function reviewConflicts(state: RoomState, msg: Message, now: Date): string[] {
  const resolved: string[] = [];
  for (const x of state.unresolvedConflicts()) {
    const active = x.claimIds.map((id) => state.claims.get(id)!).filter((k) => k.status === "active");
    const polarities = new Set(active.map((k) => k.polarity));
    const agents = new Set(active.map((k) => k.agentId));
    if (polarities.size <= 1 || agents.size <= 1) {
      x.resolutionMessageIds.push(msg.id);
      transition(state, "conflict", x, "resolved", msg, now);
      resolved.push(x.id);
    }
  }
  return resolved;
}

export async function applyEvents(
  state: RoomState,
  msg: Message,
  events: ExtractedEvent[],
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const result: ApplyResult = { created: [], changed: [], newConflicts: [] };
  const now = ctx.now;
  const isCorrection = events.some((e) => e.type === "correction");
  const answerMarker = events.some((e) => e.type === "answer");
  let answeredSomething = false;

  for (const e of events) {
    if (!admissible(e, msg, events, ctx)) continue;
    const p = e.payload;

    switch (e.type) {
      case "question":
      case "request": {
        const targets = e.target_agents
          .map((n) => resolveAgent(state, n))
          .filter((x): x is string => !!x && x !== msg.authorId);
        // §9.4: a request with a named target is a Handoff, one per target.
        if (e.type === "request" && targets.length > 0) {
          for (const to of targets) {
            const h: Handoff = {
              id: state.nextId("handoff"),
              fromAgentId: msg.authorId,
              toAgentId: to,
              action: p.text ?? msg.text,
              sourceMessageId: msg.id,
              status: "pending",
              createdAt: now.toISOString(),
              createdIndex: state.roomIndex,
              derivedFromMessageIds: [msg.id],
              extractorConfidence: e.confidence,
            };
            state.handoffs.set(h.id, h);
            created(state, "handoff", h.id, "pending", msg, now);
            result.created.push(h.id);
          }
          break;
        }
        const q: Question = {
          id: state.nextId("question"),
          kind: e.type === "request" ? "request" : "question",
          sourceMessageId: msg.id,
          askerId: msg.authorId,
          targetIds: targets,
          text: p.text ?? msg.text,
          status: "open",
          answerMessageIds: [],
          createdAt: now.toISOString(),
          createdIndex: state.roomIndex,
          derivedFromMessageIds: [msg.id],
          extractorConfidence: e.confidence,
        };
        state.questions.set(q.id, q);
        created(state, "question", q.id, "open", msg, now);
        result.created.push(q.id);
        break;
      }

      case "commitment": {
        const action = p.action ?? msg.text;
        const conditional = p.conditional === true;
        // "I'll do it" in answer to a handoff accepts that handoff.
        const pending = conditional ? undefined : handoffFor(state, msg, action);
        if (pending) {
          const c = acceptHandoff(state, pending, msg, e, now);
          result.changed.push(pending.id);
          result.created.push(c.id);
          break;
        }
        // Confirming your own earlier tentative offer promotes it instead.
        const proposed = [...state.commitments.values()].find(
          (c) => c.ownerId === msg.authorId && c.status === "proposed" && textSimilarity(c.action, action) >= 0.6,
        );
        if (proposed && !conditional) {
          proposed.optional = false;
          proposed.derivedFromMessageIds.push(msg.id);
          transition(state, "commitment", proposed, "in_progress", msg, now);
          result.changed.push(proposed.id);
          break;
        }
        const c = newCommitment(state, msg, e, action, conditional, now);
        result.created.push(c.id);
        break;
      }

      case "status_update": {
        const c = latestActiveCommitment(state, msg.authorId, p.action);
        if (c) {
          touch(state, c, now);
          c.derivedFromMessageIds.push(msg.id);
          if (c.status === "proposed" || c.status === "accepted" || c.status === "blocked") {
            c.optional = false;
            transition(state, "commitment", c, "in_progress", msg, now);
            result.changed.push(c.id);
          }
        } else if (p.action) {
          result.created.push(newCommitment(state, msg, e, p.action, false, now).id);
        }
        break;
      }

      case "completion": {
        const c = latestActiveCommitment(state, msg.authorId, p.action);
        if (c) {
          c.completionMessageId = msg.id;
          c.derivedFromMessageIds.push(msg.id);
          transition(state, "commitment", c, "completed", msg, now);
          result.changed.push(c.id);
        }
        break;
      }

      case "withdrawal": {
        const h = handoffFor(state, msg);
        if (h) {
          h.acknowledgementMessageId = msg.id;
          transition(state, "handoff", h, "declined", msg, now);
          result.changed.push(h.id);
          break;
        }
        const c = latestActiveCommitment(state, msg.authorId);
        if (c) {
          c.derivedFromMessageIds.push(msg.id);
          transition(state, "commitment", c, "cancelled", msg, now);
          result.changed.push(c.id);
          break;
        }
        const q = state.openQuestions().filter((x) => x.askerId === msg.authorId).pop();
        if (q) {
          transition(state, "question", q, "withdrawn", msg, now);
          result.changed.push(q.id);
        }
        break;
      }

      case "acknowledgement": {
        const h = handoffFor(state, msg);
        if (h) {
          const c = acceptHandoff(state, h, msg, e, now);
          result.changed.push(h.id);
          result.created.push(c.id);
          break;
        }
        const q = msg.replyToId ? state.openQuestions().find((x) => x.sourceMessageId === msg.replyToId) : undefined;
        if (q && q.status === "open") {
          q.ackIndex = state.roomIndex;
          transition(state, "question", q, "acknowledged", msg, now);
          result.changed.push(q.id);
        }
        break;
      }

      case "claim": {
        if (!p.subject || !p.predicate || !p.polarity) break;
        if (isCorrection) {
          // Retract the author's earlier claims on the same subject (§22 resolution a).
          const subj = contentTokens(p.subject);
          for (const k of state.activeClaims()) {
            if (k.agentId === msg.authorId && overlap(subj, contentTokens(k.subject)) >= 0.85) {
              transition(state, "claim", k, "retracted", msg, now);
              result.changed.push(k.id);
            }
          }
        }
        const k: Claim = {
          id: state.nextId("claim"),
          agentId: msg.authorId,
          messageId: msg.id,
          subject: p.subject,
          predicate: p.predicate,
          polarity: p.polarity,
          conditions: p.conditions ?? [],
          hedged: p.hedged === true,
          status: "active",
          createdAt: now.toISOString(),
          createdIndex: state.roomIndex,
          derivedFromMessageIds: [msg.id],
          extractorConfidence: e.confidence,
        };
        state.claims.set(k.id, k);
        created(state, "claim", k.id, "active", msg, now);
        result.created.push(k.id);

        const q = questionAnswered(state, msg, k);
        if (q) {
          k.answersQuestionId = q.id;
          answer(state, q, msg, now);
          answeredSomething = true;
          result.changed.push(q.id);
        }
        if (isCorrection) result.changed.push(...reviewConflicts(state, msg, now));
        result.newConflicts.push(...(await linkConflicts(state, k, msg, ctx)));
        break;
      }

      case "correction":
      case "answer":
        break; // handled alongside claims

      default:
        ctx.log?.(`#${msg.seq}: ${e.type} not tracked in MVP`);
    }
  }

  // An answer with no parseable claim still resolves a question it replies to.
  if (answerMarker && !answeredSomething) {
    const q = questionAnswered(state, msg, null);
    if (q) {
      answer(state, q, msg, now);
      result.changed.push(q.id);
    }
  }
  result.changed.push(...syncHandoffs(state, msg, now));
  return result;
}
