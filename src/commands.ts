// `@chorus` commands (spec §29, §53) and permission-checked feedback (§60).
// Deterministic; no LLM involved. Replies are solicited and exempt from limits.

import type { Mode } from "./config.ts";
import { completionReport, describeClaim, formatCompletion } from "./rules/rules.ts";
import type { RoomState } from "./state/room.ts";
import type { Message } from "./state/types.ts";

export const COMMAND = /^\s*@chorus\b\s*(.*)$/is;

export interface CommandResult {
  reply: string;
  /** state changed; re-run rules */
  changed: boolean;
}

const HELP = [
  "Chorus commands:",
  "@chorus status | open | commitments | conflicts | close-check",
  "@chorus resolved <id> | ignore <id> | wrong [id] | correct [id]",
  "@chorus mode observe|assist|facilitate",
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
    lines.push(`${c.id} — ${state.agentName(c.ownerId)}: ${c.action} [${c.status}${c.optional ? ", optional" : ""}]`);
  }
  for (const x of state.unresolvedConflicts()) lines.push(`${x.id} — conflict: ${x.subject} [${x.status}]`);
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
    return { reply: `No object ${id}.`, changed: false };
  }

  if (verb === "ignore") {
    const q = state.questions.get(id);
    const c = state.commitments.get(id);
    const x = state.conflicts.get(id);
    const owner = q?.askerId ?? c?.ownerId;
    if (q || c) {
      if (who !== owner) return deny(`only the asker/owner may ignore ${id}`);
      (q ?? c)!.ignored = true;
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

export function runCommand(state: RoomState, msg: Message, now: Date): CommandResult {
  const m = COMMAND.exec(msg.text);
  const [verb = "", arg] = (m?.[1] ?? "").trim().split(/\s+/);
  switch (verb.toLowerCase()) {
    case "status":
      return { reply: status(state), changed: false };
    case "open":
      return { reply: open(state), changed: false };
    case "commitments":
      return { reply: commitments(state), changed: false };
    case "conflicts":
      return { reply: conflictList(state), changed: false };
    case "close-check":
    case "close_check":
      return { reply: formatCompletion(state, completionReport(state)), changed: false };
    case "mode": {
      const mode = arg?.toLowerCase();
      if (mode !== "observe" && mode !== "assist" && mode !== "facilitate") {
        return { reply: `Mode is ${state.mode}. Usage: @chorus mode observe|assist|facilitate`, changed: false };
      }
      state.mode = mode as Mode;
      return { reply: `Mode set to ${mode}.`, changed: true };
    }
    case "resolved":
    case "ignore":
    case "wrong":
    case "correct":
      return feedback(state, verb.toLowerCase(), arg, msg, now);
    default:
      return { reply: HELP, changed: false };
  }
}
