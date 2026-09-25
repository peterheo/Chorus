// Stretch features (spec §78): agent-specific brief on rejoin, conversation
// health as separate dimensions (not one good/bad score), the agent
// interaction map, and topic threads.

import { contentTokens, overlap } from "./similarity.ts";
import type { RoomState } from "./state/room.ts";

// ── Agent brief ─────────────────────────────────────────────────────────────

/**
 * "Since you were last active": what changed since room index `sinceIndex`
 * that concerns `agentId` or the whole room, plus what is waiting on them now.
 */
export function agentBrief(s: RoomState, agentId: string, sinceIndex: number, sinceTime: string): string[] {
  const lines: string[] = [];
  const concerns = (id: string): boolean => {
    const q = s.questions.get(id);
    if (q) return q.askerId === agentId || q.targetIds.includes(agentId);
    const c = s.commitments.get(id);
    if (c) return c.ownerId === agentId || s.waitingDependencies().some((p) => p.blockedAgentId === agentId && p.blockingObjectId === id);
    const h = s.handoffs.get(id);
    if (h) return h.fromAgentId === agentId || h.toAgentId === agentId;
    const p = s.dependencies.get(id);
    if (p) return p.blockedAgentId === agentId;
    return false;
  };
  const roomWide = (kind: string, to: string) =>
    (kind === "decision" && (to === "active" || to === "superseded")) || (kind === "conflict" && (to === "confirmed" || to === "resolved"));

  const seen = new Set<string>();
  for (const t of s.transitions) {
    const m = t.messageId ? s.message(t.messageId) : undefined;
    const after = m ? m.roomIndex > sinceIndex : t.at > sinceTime;
    if (!after || t.kind === "room" || t.kind === "claim") continue;
    if (m?.authorId === agentId) continue; // their own actions need no recap
    if (!concerns(t.objectId) && !roomWide(t.kind, t.to)) continue;
    const key = `${t.objectId}:${t.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cite = m ? ` (#${m.seq})` : "";
    const o = s.object(t.objectId);
    const what =
      o && "text" in o ? `"${o.text}"` : o && "action" in o ? `"${o.action}"` : o && "statement" in o ? `"${o.statement}"` : o && "subject" in o ? `on ${o.subject}` : "";
    if (t.kind === "handoff" && t.to === "pending" && o && "toAgentId" in o && o.toAgentId === agentId) {
      lines.push(`${s.agentName(o.fromAgentId)} handed ${t.objectId} to you: ${o.action}${cite}`);
    } else if (t.from === null) {
      lines.push(`${t.objectId} ${what} was created${cite}`);
    } else {
      lines.push(`${t.objectId} ${what} → ${t.to}${t.reason ? ` (${t.reason})` : ""}${cite}`);
    }
  }
  for (const x of s.unresolvedConflicts().filter((x) => x.status === "confirmed")) {
    if (!seen.has(`${x.id}:confirmed`)) lines.push(`${x.id} on ${x.subject} remains unresolved`);
  }
  const forYou = [
    ...s.pendingHandoffs().filter((h) => h.toAgentId === agentId).map((h) => `${h.id} (handoff from ${s.agentName(h.fromAgentId)})`),
    ...s.openQuestions().filter((q) => q.targetIds.includes(agentId)).map((q) => `${q.id} (question to you)`),
  ];
  if (forYou.length) lines.push(`Waiting on you: ${forYou.join(", ")}`);
  return lines;
}

// ── Health dimensions ────────────────────────────────────────────────────────

/** §78: dimensions, deliberately not collapsed into one score. */
export function health(s: RoomState) {
  const openQ = s.openQuestions();
  const surfaced = new Set(
    s.posted.filter((p) => p.candidate.type === "unanswered_question").flatMap((p) => p.candidate.relatedObjectIds),
  );
  const activeDupPairs = s.posted
    .filter((p) => p.candidate.type === "duplicate_work")
    .filter((p) => p.candidate.relatedObjectIds.filter((id) => s.commitments.get(id)?.status === "in_progress").length >= 2);
  const stalledAfter = 20;
  return {
    open_obligations: {
      questions: openQ.length,
      commitments: s.activeCommitments().filter((c) => !c.optional).length,
      handoffs: s.pendingHandoffs().length,
    },
    duplicate_work: { active_pairs: activeDupPairs.length },
    unresolved_conflicts: { confirmed: s.unresolvedConflicts().filter((x) => x.status === "confirmed").length },
    stalled_dependencies: {
      waiting: s.waitingDependencies().length,
      stalled: s.waitingDependencies().filter((p) => s.roomIndex - p.createdIndex >= stalledAfter).length,
      stalled_after_messages: stalledAfter,
    },
    unanswered_questions: {
      surfaced_and_still_open: openQ.filter((q) => surfaced.has(q.id)).length,
      oldest_age_messages: openQ.length ? Math.max(...openQ.map((q) => s.roomIndex - q.createdIndex)) : 0,
    },
    blocked_commitments: s.activeCommitments().filter((c) => c.status === "blocked").length,
  };
}

// ── Interaction map ──────────────────────────────────────────────────────────

export interface InteractionEdge {
  from: string;
  to: string;
  replies: number;
  handoffs: number;
  dependencies: number;
  total: number;
}

/** §78: who addresses whom — replies, handoffs, and dependencies. */
export function interactionMap(s: RoomState): InteractionEdge[] {
  const edges = new Map<string, InteractionEdge>();
  const bump = (from: string, to: string, k: "replies" | "handoffs" | "dependencies") => {
    if (!from || !to || from === to || from === s.chorusAgentId || to === s.chorusAgentId) return;
    const key = `${from}\u0000${to}`;
    const e = edges.get(key) ?? { from, to, replies: 0, handoffs: 0, dependencies: 0, total: 0 };
    e[k]++;
    e.total++;
    edges.set(key, e);
  };
  for (const m of s.messages) {
    if (m.replyToId) bump(m.authorId, s.message(m.replyToId)?.authorId ?? "", "replies");
  }
  for (const h of s.handoffs.values()) bump(h.fromAgentId, h.toAgentId, "handoffs");
  for (const p of s.dependencies.values()) {
    const b = s.object(p.blockingObjectId);
    const owner = b && "ownerId" in b ? b.ownerId : b && "toAgentId" in b ? b.toAgentId : b && "askerId" in b ? b.askerId : "";
    bump(p.blockedAgentId, owner, "dependencies");
  }
  return [...edges.values()].sort((a, b) => b.total - a.total);
}

// ── Topic threads ────────────────────────────────────────────────────────────

export interface Thread {
  label: string;
  objects: string[];
  agents: string[];
  open: number;
}

/**
 * §78: separate simultaneous conversations. Objects (questions, commitments,
 * claims, handoffs, decisions) are linked when their text shares enough
 * content words, or when one answers/blocks/claims another; each connected
 * group is a thread, labelled by its most common words.
 */
export function threads(s: RoomState): Thread[] {
  type Node = { id: string; tokens: Set<string>; agent: string; open: boolean };
  const nodes: Node[] = [];
  for (const q of s.questions.values()) {
    nodes.push({ id: q.id, tokens: contentTokens(q.text), agent: q.askerId, open: q.status === "open" || q.status === "acknowledged" });
  }
  for (const c of s.commitments.values()) {
    nodes.push({ id: c.id, tokens: contentTokens(c.action), agent: c.ownerId, open: ["proposed", "accepted", "in_progress", "blocked"].includes(c.status) });
  }
  for (const k of s.claims.values()) {
    nodes.push({ id: k.id, tokens: contentTokens(`${k.subject} ${k.predicate}`), agent: k.agentId, open: false });
  }
  for (const h of s.handoffs.values()) {
    nodes.push({ id: h.id, tokens: contentTokens(h.action), agent: h.fromAgentId, open: h.status === "pending" });
  }
  for (const d of s.decisions.values()) {
    nodes.push({ id: d.id, tokens: contentTokens(d.statement), agent: d.decidedBy, open: false });
  }

  // Union-find over lexical similarity and explicit links.
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  const union = (a: string, b: string) => {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  };
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (overlap(nodes[i]!.tokens, nodes[j]!.tokens) >= 0.5) union(nodes[i]!.id, nodes[j]!.id);
    }
  }
  for (const k of s.claims.values()) if (k.answersQuestionId) union(k.id, k.answersQuestionId);
  for (const q of s.questions.values()) if (q.claimedByCommitmentId) union(q.id, q.claimedByCommitmentId);
  for (const h of s.handoffs.values()) if (h.resultingCommitmentId) union(h.id, h.resultingCommitmentId);
  for (const x of s.conflicts.values()) for (const k of x.claimIds.slice(1)) union(x.claimIds[0]!, k);

  const groups = new Map<string, Node[]>();
  for (const n of nodes) {
    const root = find(n.id);
    groups.set(root, [...(groups.get(root) ?? []), n]);
  }
  return [...groups.values()]
    .map((g) => {
      const freq = new Map<string, number>();
      for (const n of g) for (const t of n.tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
      const label = [...freq.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([t]) => t)
        .join(" ");
      return {
        label: label || "(untitled)",
        objects: g.map((n) => n.id),
        agents: [...new Set(g.map((n) => n.agent))],
        open: g.filter((n) => n.open).length,
      };
    })
    .sort((a, b) => b.open - a.open || b.objects.length - a.objects.length);
}
