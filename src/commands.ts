// `@chorus` commands (spec §29, §53) and permission-checked feedback (§60).
// Deterministic; no LLM involved. Replies are solicited and exempt from limits.

import type { Mode } from "./config.ts";
import { metrics } from "./metrics.ts";
import {
  WATCH_DEFAULT_MINUTES,
  WATCH_MAX_MINUTES,
  analysisBody,
  endSession,
  issueReceipt,
  openObligations,
  snapshotBody,
  summarizeObligations,
} from "./operations.ts";
import type { ReceiptSigner } from "./receipts.ts";
import type { SignedReceiptRecord } from "./state/room.ts";
import { completionReport, describeClaim, formatCompletion } from "./rules/rules.ts";
import type { RoomState } from "./state/room.ts";
import type { Message } from "./state/types.ts";

export const COMMAND = /^\s*@chorus\b\s*(.*)$/is;

export interface CommandResult {
  reply: string;
  /** state changed; re-run rules */
  changed: boolean;
  /** a receipt issued by this command (§54) */
  receipt?: SignedReceiptRecord;
}

export interface CommandContext {
  now: Date;
  /** room ID as shown in receipts */
  room: string;
  signer?: ReceiptSigner;
  /** §43 operations (watch, facilitate, replay) enabled by config */
  operationsEnabled: boolean;
}

const HELP = [
  "Chorus commands:",
  "@chorus status | open | commitments | conflicts | decisions | what-am-i-waiting-on | close-check",
  "@chorus resolved <id> | ignore <id> | wrong [id] | correct [id] | reopen <D…>",
  "@chorus mode observe|assist|facilitate",
  "@chorus watch [minutes] | facilitate | stop | replay | receipt | metrics",
].join("\n");

function status(state: RoomState): string {
  const window = state.roomIndex - 30;
  const active = [...state.agents.values()].filter((a) => a.id !== state.chorusAgentId && a.lastRoomIndex > window);
  const open = state.openQuestions();
  const inProgress = state.activeCommitments().filter((c) => c.status === "in_progress");
  const confirmed = state.unresolvedConflicts().filter((x) => x.status === "confirmed");
  const candidates = state.unresolvedConflicts().filter((x) => x.status === "candidate");
  const lines = [
    `ROOM STATUS (as of #${state.messages.at(-1)?.seq ?? 0}, mode: ${state.mode})`,
    "",
    `Agents active: ${active.length}`,
    "",
    `Open questions: ${open.length}`,
    `Commitments in progress: ${inProgress.length}`,
    `Pending handoffs: ${state.pendingHandoffs().length}`,
    `Agents waiting on others: ${new Set(state.waitingDependencies().map((p) => p.blockedAgentId)).size}`,
    `Active decisions: ${state.activeDecisions().length}`,
    `Unresolved conflicts: ${confirmed.length}${candidates.length ? ` (+${candidates.length} unconfirmed)` : ""}`,
  ];
  const oldest = open
    .filter((q) => !q.ignored)
    .sort((a, b) => a.createdIndex - b.createdIndex)[0];
  if (confirmed[0]) {
    lines.push("", "Highest priority:", `${confirmed[0].id} — conflict on ${confirmed[0].subject}.`);
  } else if (oldest) {
    lines.push(
      "",
      "Highest priority:",
      `${oldest.id} has been unanswered for ${state.roomIndex - oldest.createdIndex} messages.`,
    );
  }
  return lines.join("\n");
}

function open(state: RoomState): string {
  const lines: string[] = [];
  for (const q of state.openQuestions()) {
    const tag = q.kind === "request" ? "request" : "question";
    const claimed = q.claimedByCommitmentId ? `, taken by ${q.claimedByCommitmentId}` : "";
    lines.push(`${q.id} (${tag}${claimed}) — ${q.text} [${state.agentName(q.askerId)}, ${state.cite(q.sourceMessageId)}]`);
  }
  for (const c of state.activeCommitments()) {
    const due = c.deadline ? `, due ${c.deadline.slice(11, 16)} UTC` : "";
    lines.push(`${c.id} — ${state.agentName(c.ownerId)}: ${c.action} [${c.status}${c.optional ? ", optional" : ""}${due}]`);
  }
  for (const h of state.pendingHandoffs()) {
    lines.push(`${h.id} — handoff ${state.agentName(h.fromAgentId)} → ${state.agentName(h.toAgentId)}: ${h.action} [pending, ${state.cite(h.sourceMessageId)}]`);
  }
  for (const x of state.unresolvedConflicts()) lines.push(`${x.id} — conflict: ${x.subject} [${x.status}]`);
  for (const p of state.waitingDependencies()) {
    lines.push(`${p.id} — ${state.agentName(p.blockedAgentId)} waiting on ${p.blockingObjectId}`);
  }
  return lines.length ? ["OPEN ITEMS", "", ...lines].join("\n") : "No open items.";
}

function commitments(state: RoomState): string {
  const all = [...state.commitments.values()];
  if (!all.length) return "No commitments recorded.";
  return [
    "COMMITMENTS",
    "",
    ...all.map((c) => `${c.id} — ${state.agentName(c.ownerId)}: ${c.action} [${c.status}] (${state.cite(c.sourceMessageId)})`),
  ].join("\n");
}

function conflictList(state: RoomState): string {
  const all = [...state.conflicts.values()];
  if (!all.length) return "No conflicts recorded.";
  const lines = ["CONFLICTS", ""];
  for (const x of all) {
    lines.push(`${x.id} — ${x.subject} [${x.status}]`);
    for (const id of x.claimIds) {
      const k = state.claims.get(id)!;
      lines.push(`  ${state.agentName(k.agentId)} (${state.cite(k.messageId)}): ${describeClaim(k)}${k.status !== "active" ? ` [${k.status}]` : ""}`);
    }
  }
  return lines.join("\n");
}

function decisions(state: RoomState): string {
  const all = [...state.decisions.values()];
  if (!all.length) return "No decisions recorded.";
  const lines = ["DECISIONS", ""];
  for (const d of all) {
    const note = d.status === "superseded" ? ` [superseded by ${d.supersededBy}]` : d.status === "reopened" ? " [reopened]" : "";
    lines.push(`${d.id} — ${d.statement} (${state.agentName(d.decidedBy)}, ${state.cite(d.sourceMessageIds[0]!)})${note}`);
  }
  return lines.join("\n");
}

function waitingOn(state: RoomState, who: string): string {
  const mine = state.waitingDependencies().filter((p) => p.blockedAgentId === who);
  const handoffs = state.pendingHandoffs().filter((h) => h.fromAgentId === who);
  const questions = state.openQuestions().filter((q) => q.askerId === who);
  if (!mine.length && !handoffs.length && !questions.length) return "You are not waiting on anything Chorus is tracking.";
  const lines = ["YOU ARE WAITING ON", ""];
  for (const p of mine) {
    const b = state.object(p.blockingObjectId);
    const what = b && "action" in b ? b.action : b && "text" in b ? b.text : b && "statement" in b ? b.statement : "";
    lines.push(`${p.id} → ${p.blockingObjectId} ${what} [${b?.status ?? "unknown"}]`);
  }
  for (const h of handoffs) lines.push(`${h.id} → ${state.agentName(h.toAgentId)} to accept: ${h.action}`);
  for (const q of questions) lines.push(`${q.id} → an answer: ${q.text}`);
  return lines.join("\n");
}

function feedback(state: RoomState, verb: string, arg: string | undefined, msg: Message, now: Date): CommandResult {
  const who = msg.authorId;
  const deny = (rule: string): CommandResult => ({ reply: `Not applied: ${rule}.`, changed: false });
  const lastForMe = [...state.posted].reverse().find((p) => !p.solicited && p.candidate.involvedAgentIds.includes(who));

  if (verb === "correct" || verb === "wrong") {
    const id = arg?.toUpperCase();
    // `wrong X3` on a conflict dismisses it (claimants only).
    if (verb === "wrong" && id?.startsWith("X")) {
      const x = state.conflicts.get(id);
      if (!x) return { reply: `No conflict ${id}.`, changed: false };
      const claimants = x.claimIds.map((k) => state.claims.get(k)!.agentId);
      if (!claimants.includes(who)) return deny(`only agents with a claim in ${id} may dismiss it`);
      state.record({ objectId: x.id, kind: "conflict", from: x.status, to: "dismissed", cause: "feedback", messageId: msg.id, at: now.toISOString() });
      x.status = "dismissed";
      return { reply: `${id} dismissed.`, changed: true };
    }
    const target = lastForMe ?? state.posted.at(-1);
    if (!target) return { reply: "No intervention to give feedback on.", changed: false };
    if (!target.candidate.involvedAgentIds.includes(who)) return deny("only agents involved in an intervention may rate it");
    if (verb === "wrong") state.suppressedKeys.add(target.candidate.idempotencyKey);
    target.feedback = verb as "correct" | "wrong";
    return { reply: `Recorded: ${verb} (${target.candidate.type}). Thanks.`, changed: false };
  }

  if (!arg) return { reply: `Usage: @chorus ${verb} <id>`, changed: false };
  const id = arg.toUpperCase();

  if (verb === "resolved") {
    const q = state.questions.get(id);
    if (q) {
      const answerers = q.answerMessageIds.map((m) => state.message(m)?.authorId);
      if (who !== q.askerId && !answerers.includes(who)) return deny(`only the asker or an answerer may resolve ${id}`);
      state.record({ objectId: q.id, kind: "question", from: q.status, to: "answered", cause: "feedback", messageId: msg.id, at: now.toISOString() });
      q.status = "answered";
      q.resolvedAt = now.toISOString();
      return { reply: `${id} marked answered.`, changed: true };
    }
    const c = state.commitments.get(id);
    if (c) {
      if (who !== c.ownerId) return deny(`only the owner may complete ${id}`);
      state.record({ objectId: c.id, kind: "commitment", from: c.status, to: "completed", cause: "feedback", messageId: msg.id, at: now.toISOString() });
      c.status = "completed";
      c.completionMessageId = msg.id;
      return { reply: `${id} marked completed.`, changed: true };
    }
    const x = state.conflicts.get(id);
    if (x) {
      const claimants = x.claimIds.map((k) => state.claims.get(k)!.agentId);
      if (!claimants.includes(who)) return deny(`only agents with a claim in ${id} may resolve it`);
      state.record({ objectId: x.id, kind: "conflict", from: x.status, to: "resolved", cause: "feedback", messageId: msg.id, at: now.toISOString() });
      x.status = "resolved";
      x.resolutionMessageIds.push(msg.id);
      return { reply: `${id} marked resolved.`, changed: true };
    }
    const h = state.handoffs.get(id);
    if (h) {
      if (who !== h.fromAgentId && who !== h.toAgentId) return deny(`only the sender or recipient may resolve ${id}`);
      const c = h.resultingCommitmentId ? state.commitments.get(h.resultingCommitmentId) : undefined;
      if (c && c.status !== "completed") {
        state.record({ objectId: c.id, kind: "commitment", from: c.status, to: "completed", cause: "feedback", messageId: msg.id, at: now.toISOString() });
        c.status = "completed";
        c.completionMessageId = msg.id;
      }
      state.record({ objectId: h.id, kind: "handoff", from: h.status, to: "completed", cause: "feedback", messageId: msg.id, at: now.toISOString() });
      h.status = "completed";
      return { reply: `${id} marked completed.`, changed: true };
    }
    return { reply: `No object ${id}.`, changed: false };
  }

  if (verb === "reopen") {
    const d = state.decisions.get(id);
    if (!d) return { reply: `No decision ${id}.`, changed: false };
    // §60: any agent may reopen a decision.
    state.record({ objectId: d.id, kind: "decision", from: d.status, to: "reopened", cause: "feedback", messageId: msg.id, at: now.toISOString() });
    d.status = "reopened";
    return { reply: `${id} reopened: "${d.statement}". Chorus will stop reminding the room about it.`, changed: true };
  }

  if (verb === "ignore") {
    const q = state.questions.get(id);
    const c = state.commitments.get(id);
    const x = state.conflicts.get(id);
    const h = state.handoffs.get(id);
    const owner = q?.askerId ?? c?.ownerId;
    if (q || c) {
      if (who !== owner) return deny(`only the asker/owner may ignore ${id}`);
      (q ?? c)!.ignored = true;
      return { reply: `${id} will not be raised unsolicited.`, changed: true };
    }
    if (h) {
      if (who !== h.fromAgentId) return deny(`only the sender may ignore ${id}`);
      h.ignored = true;
      return { reply: `${id} will not be raised unsolicited.`, changed: true };
    }
    if (x) {
      const claimants = x.claimIds.map((k) => state.claims.get(k)!.agentId);
      if (!claimants.includes(who)) return deny(`only agents with a claim in ${id} may ignore it`);
      x.ignored = true;
      return { reply: `${id} will not be raised unsolicited.`, changed: true };
    }
    return { reply: `No object ${id}.`, changed: false };
  }
  return { reply: HELP, changed: false };
}

function operations(state: RoomState, verb: string, arg: string | undefined, msg: Message, ctx: CommandContext): CommandResult {
  if (!ctx.operationsEnabled) return { reply: `@chorus ${verb} is not enabled in this room.`, changed: false };
  if (!ctx.signer) return { reply: "Receipts are not configured for this Chorus.", changed: false };
  const now = ctx.now;

  if (verb === "receipt") {
    const r = issueReceipt(state, ctx.signer, snapshotBody(state, ctx.room, now), summarizeObligations(openObligations(state)));
    return { reply: r.text, changed: false, receipt: r.record };
  }
  if (verb === "replay") {
    const m = metrics(state);
    const ratio = m.useful_ratio === null ? "n/a" : `${Math.round(m.useful_ratio * 100)}%`;
    const r = issueReceipt(
      state,
      ctx.signer,
      analysisBody(state, ctx.room, now),
      `Post-room analysis: ${m.questions_resolved}/${m.questions_detected} questions answered, ` +
        `${m.commitments_completed}/${m.commitments_created} commitments completed, ` +
        `${m.conflicts_resolved}/${m.conflicts_detected} conflicts resolved, ${m.interventions_posted} interventions (${ratio} useful).`,
    );
    return { reply: r.text, changed: false, receipt: r.record };
  }
  if (verb === "stop") {
    if (!state.session) return { reply: "No watch or facilitation session is running.", changed: false };
    const r = endSession(state, ctx.room, now, ctx.signer, `${state.session.kind === "watch" ? "Watch" : "Facilitation"} stopped`);
    return { reply: r.text, changed: true, receipt: r.record };
  }
  // watch / facilitate
  if (state.session) {
    return { reply: `A ${state.session.kind} session is already running. "@chorus stop" ends it.`, changed: false };
  }
  const minutes =
    verb === "watch" ? Math.min(Math.max(Number(arg) || WATCH_DEFAULT_MINUTES, 1), WATCH_MAX_MINUTES) : undefined;
  state.session = {
    kind: verb as "watch" | "facilitate",
    requestedBy: msg.authorId,
    startedAt: now.toISOString(),
    startedSeq: msg.seq,
    until: minutes ? new Date(now.getTime() + minutes * 60_000).toISOString() : undefined,
    previousMode: state.mode,
  };
  state.mode = "facilitate";
  return {
    reply:
      verb === "watch"
        ? `Watching this room for ${minutes} minutes in facilitate mode. A signed receipt follows when it ends.`
        : `Facilitating this room until "@chorus stop". A signed receipt follows when it ends.`,
    changed: true,
  };
}

function metricsReply(state: RoomState): string {
  const m = metrics(state);
  const ratio = m.useful_ratio === null ? "n/a" : `${Math.round(m.useful_ratio * 100)}%`;
  return [
    "CHORUS METRICS",
    "",
    `Useful interventions: ${ratio} (${m.interventions_followed} followed, ${m.interventions_ignored} ignored, ${m.interventions_pending} pending)`,
    `Interventions posted: ${m.interventions_posted} · suppressed: ${m.interventions_suppressed} · marked wrong: ${m.false_positive_feedback}`,
    `Questions: ${m.questions_resolved}/${m.questions_detected} answered · Commitments: ${m.commitments_completed}/${m.commitments_created} completed`,
    `Conflicts: ${m.conflicts_resolved}/${m.conflicts_detected} resolved · Duplicates: ${m.duplicates_confirmed}/${m.duplicates_detected} confirmed`,
  ].join("\n");
}

export function runCommand(state: RoomState, msg: Message, ctx: CommandContext): CommandResult {
  const now = ctx.now;
  const m = COMMAND.exec(msg.text);
  const [verb = "", arg] = (m?.[1] ?? "").trim().split(/\s+/);
  switch (verb.toLowerCase()) {
    case "receipt":
    case "replay":
    case "watch":
    case "facilitate":
    case "stop":
      return operations(state, verb.toLowerCase(), arg, msg, ctx);
    case "metrics":
      return { reply: metricsReply(state), changed: false };
    case "status":
      return { reply: status(state), changed: false };
    case "open":
      return { reply: open(state), changed: false };
    case "commitments":
      return { reply: commitments(state), changed: false };
    case "conflicts":
      return { reply: conflictList(state), changed: false };
    case "decisions":
      return { reply: decisions(state), changed: false };
    case "what-am-i-waiting-on":
    case "waiting":
      return { reply: waitingOn(state, msg.authorId), changed: false };
    case "close-check":
    case "close_check":
      return { reply: formatCompletion(state, completionReport(state)), changed: false };
    case "mode": {
      const mode = arg?.toLowerCase();
      if (mode !== "observe" && mode !== "assist" && mode !== "facilitate") {
        return { reply: `Mode is ${state.mode}. Usage: @chorus mode observe|assist|facilitate`, changed: false };
      }
      state.mode = mode as Mode;
      const ended = state.session ? ` The running ${state.session.kind} session was cancelled.` : "";
      state.session = null;
      return { reply: `Mode set to ${mode}.${ended}`, changed: true };
    }
    case "resolved":
    case "reopen":
    case "ignore":
    case "wrong":
    case "correct":
      return feedback(state, verb.toLowerCase(), arg, msg, now);
    default:
      return { reply: HELP, changed: false };
  }
}
