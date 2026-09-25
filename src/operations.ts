// Chorus operations (spec §43) and their signed receipts (§54):
//   chorus.watch       time-boxed facilitate mode, receipt when it ends
//   chorus.facilitate  facilitate mode until stopped, receipt when it ends
//   chorus.replay      post-room analysis, as a receipt
//   receipt            a signed snapshot of open obligations
// Payment is transport-specific and not implemented; operations are enabled
// by config (§43).

import { createHash } from "node:crypto";
import type { ChorusConfig } from "./config.ts";
import { metrics } from "./metrics.ts";
import type { ReceiptSigner } from "./receipts.ts";
import { completionReport } from "./rules/rules.ts";
import type { RoomState, SignedReceiptRecord } from "./state/room.ts";
import type { Order, PaymentRef } from "./state/types.ts";
import type { CreditTransfer } from "./transport/types.ts";

export const WATCH_DEFAULT_MINUTES = 10;
export const WATCH_MAX_MINUTES = 120;

function messageRange(s: RoomState, fromSeq = 0): [number, number] | null {
  const seqs = s.messages.filter((m) => m.seq > fromSeq).map((m) => m.seq);
  return seqs.length ? [Math.min(...seqs), Math.max(...seqs)] : null;
}

function openObligations(s: RoomState) {
  return {
    open_questions: s.openQuestions().map((q) => q.id),
    active_commitments: s.activeCommitments().filter((c) => !c.optional).map((c) => c.id),
    pending_handoffs: s.pendingHandoffs().map((h) => h.id),
    conflicts: s.unresolvedConflicts().filter((x) => x.status === "confirmed").map((x) => x.id),
    waiting_dependencies: s.waitingDependencies().map((p) => p.id),
  };
}

export function snapshotBody(s: RoomState, room: string, now: Date): Record<string, unknown> {
  return {
    chorus_operation: "facilitation_snapshot",
    room,
    message_range: messageRange(s),
    ...openObligations(s),
    active_decisions: s.activeDecisions().map((d) => d.id),
    coordination_complete: completionReport(s).complete,
    generated_at: now.toISOString(),
  };
}

export function analysisBody(s: RoomState, room: string, now: Date, payment?: PaymentRef): Record<string, unknown> {
  const m = metrics(s);
  return {
    chorus_operation: "post_room_analysis",
    ...(payment ? { payment: paymentJson(payment) } : {}),
    room,
    message_range: messageRange(s),
    surfaced: m.interventions_by_type,
    resolved: {
      questions_answered: m.questions_resolved,
      commitments_completed: m.commitments_completed,
      conflicts_resolved: m.conflicts_resolved,
    },
    still_open: openObligations(s),
    useful_ratio: m.useful_ratio,
    coordination_complete: completionReport(s).complete,
    generated_at: now.toISOString(),
  };
}

export function sessionBody(s: RoomState, room: string, now: Date): Record<string, unknown> {
  const session = s.session!;
  const during = s.posted.filter((p) => !p.solicited && p.postedAt >= session.startedAt);
  return {
    chorus_operation: session.kind === "watch" ? "watch_session" : "facilitation_session",
    room,
    ...(session.payment ? { payment: paymentJson(session.payment) } : {}),
    requested_by: session.requestedBy,
    started_at: session.startedAt,
    ended_at: now.toISOString(),
    message_range: messageRange(s, session.startedSeq),
    interventions: during.map((p) => ({
      type: p.candidate.type,
      objects: p.candidate.relatedObjectIds,
      message_id: p.messageId ?? null,
    })),
    still_open: openObligations(s),
    generated_at: now.toISOString(),
  };
}

/** Sign a body, keep it in state, and format it for the room. */
export function issueReceipt(
  s: RoomState,
  signer: ReceiptSigner,
  body: Record<string, unknown>,
  headline: string,
): { text: string; record: SignedReceiptRecord } {
  const r = signer.sign(body);
  const record: SignedReceiptRecord = {
    operation: String(body.chorus_operation),
    body: r.body,
    sha256: r.sha256,
    signature: r.signature,
    key_id: r.key_id,
  };
  s.receipts.push(record);
  const text = [
    headline,
    "",
    `RECEIPT ${record.operation} — key ${record.key_id}`,
    `sha256: ${record.sha256}`,
    `signature (Ed25519, base64url): ${record.signature}`,
    "",
    "Body (verify: sha256 of its RFC 8785 canonical form, signed with the public key at /v1/keys/" + record.key_id + "):",
    JSON.stringify(record.body),
  ].join("\n");
  return { text, record };
}

export function summarizeObligations(o: ReturnType<typeof openObligations>): string {
  const parts = [
    o.open_questions.length ? `questions ${o.open_questions.join(", ")}` : "",
    o.active_commitments.length ? `commitments ${o.active_commitments.join(", ")}` : "",
    o.pending_handoffs.length ? `handoffs ${o.pending_handoffs.join(", ")}` : "",
    o.conflicts.length ? `conflicts ${o.conflicts.join(", ")}` : "",
    o.waiting_dependencies.length ? `dependencies ${o.waiting_dependencies.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `Still open: ${parts.join("; ")}.` : "Nothing is left open.";
}

export { openObligations };

function paymentJson(p: PaymentRef) {
  return { transfer_id: p.transferId, amount: p.amount, from_principal_id: p.fromPrincipalId };
}

/** §43 post-room analysis as a signed receipt. */
export function runReplay(
  s: RoomState,
  room: string,
  now: Date,
  signer: ReceiptSigner,
  payment?: PaymentRef,
): { text: string; record: SignedReceiptRecord } {
  const m = metrics(s);
  const ratio = m.useful_ratio === null ? "n/a" : `${Math.round(m.useful_ratio * 100)}%`;
  return issueReceipt(
    s,
    signer,
    analysisBody(s, room, now, payment),
    `Post-room analysis: ${m.questions_resolved}/${m.questions_detected} questions answered, ` +
      `${m.commitments_completed}/${m.commitments_created} commitments completed, ` +
      `${m.conflicts_resolved}/${m.conflicts_detected} conflicts resolved, ${m.interventions_posted} interventions (${ratio} useful).`,
  );
}

/** Start a watch (time-boxed) or facilitate (until stopped) session. Returns the confirmation text. */
export function startSession(
  s: RoomState,
  kind: "watch" | "facilitate",
  minutes: number | undefined,
  requestedBy: string,
  startedSeq: number,
  now: Date,
  payment?: PaymentRef,
): string {
  s.session = {
    kind,
    requestedBy,
    startedAt: now.toISOString(),
    startedSeq,
    until: minutes ? new Date(now.getTime() + minutes * 60_000).toISOString() : undefined,
    previousMode: s.mode,
    payment,
  };
  s.mode = "facilitate";
  return kind === "watch"
    ? `Watching this room for ${minutes} minutes in facilitate mode. A signed receipt follows when it ends.`
    : `Facilitating this room until "@chorus stop". A signed receipt follows when it ends.`;
}

export function priceOf(op: Order["operation"], minutes: number | undefined, prices: ChorusConfig["operations"]["prices"]): number {
  if (op === "watch") return prices.watch * Math.ceil((minutes ?? WATCH_DEFAULT_MINUTES) / 10);
  return prices[op];
}

/**
 * Create an order awaiting payment. The ID is derived from the requesting
 * message, so re-processing that message after a crash quotes the same memo.
 */
export function createOrder(
  s: RoomState,
  op: Order["operation"],
  minutes: number | undefined,
  price: number,
  msg: { id: string; seq: number; authorId: string },
  room: string,
  now: Date,
  ttlMinutes: number,
): Order {
  const id = `ord_${createHash("sha256").update(`${room}\u0000${msg.id}`).digest("hex").slice(0, 12)}`;
  const order: Order = {
    id,
    operation: op,
    minutes,
    price,
    requestedBy: msg.authorId,
    requestMessageId: msg.id,
    requestSeq: msg.seq,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    status: "awaiting_payment",
  };
  s.orders.push(order);
  return order;
}

export const memoFor = (o: Order) => `chorus:${o.id}`;

export interface SettledOrder {
  order: Order;
  text: string;
  receipt?: SignedReceiptRecord;
}

/**
 * Match received transfers to orders awaiting payment and run what was paid
 * for. A transfer is used at most once, must carry the order's memo, must
 * cover the price, and must arrive after the order was placed. Unpaid orders
 * past their TTL expire.
 */
export function settleOrders(
  s: RoomState,
  transfers: CreditTransfer[],
  room: string,
  now: Date,
  signer: ReceiptSigner,
): SettledOrder[] {
  const out: SettledOrder[] = [];
  for (const order of s.orders) {
    if (order.status !== "awaiting_payment") continue;
    const t = transfers.find(
      (x) =>
        !s.usedTransfers.has(x.id) &&
        x.memo?.trim() === memoFor(order) &&
        x.amount >= order.price &&
        x.createdAt >= order.createdAt,
    );
    if (!t) {
      if (Date.parse(order.expiresAt) <= now.getTime()) order.status = "expired";
      continue;
    }
    s.usedTransfers.add(t.id);
    const payment: PaymentRef = { transferId: t.id, amount: t.amount, fromPrincipalId: t.fromPrincipalId };
    order.status = "paid";
    order.payment = payment;
    const paid = `Payment received for ${order.id} (${t.id}, ${t.amount} credits).`;
    if (order.operation === "replay") {
      const r = runReplay(s, room, now, signer, payment);
      out.push({ order, text: `${paid}\n\n${r.text}`, receipt: r.record });
      continue;
    }
    // A paid session replaces one that is already running; that one's receipt is issued first.
    let prior: { text: string; record: SignedReceiptRecord } | undefined;
    if (s.session) prior = endSession(s, room, now, signer, `${s.session.kind === "watch" ? "Watch" : "Facilitation"} ended for a new paid session`);
    const started = startSession(s, order.operation, order.minutes, order.requestedBy, order.requestSeq, now, payment);
    out.push({ order, text: [prior?.text, `${paid} ${started}`].filter(Boolean).join("\n\n"), receipt: prior?.record });
  }
  return out;
}

/** Ends the active session if its time is up. Returns the receipt message, if any. */
export function endExpiredSession(
  s: RoomState,
  room: string,
  now: Date,
  signer: ReceiptSigner,
): { text: string; record: SignedReceiptRecord } | null {
  if (!s.session?.until || Date.parse(s.session.until) > now.getTime()) return null;
  return endSession(s, room, now, signer, "Watch ended");
}

export function endSession(
  s: RoomState,
  room: string,
  now: Date,
  signer: ReceiptSigner,
  why: string,
): { text: string; record: SignedReceiptRecord } {
  const session = s.session!;
  const body = sessionBody(s, room, now);
  s.mode = session.previousMode;
  s.session = null;
  const n = (body.interventions as unknown[]).length;
  return issueReceipt(
    s,
    signer,
    body,
    `${why}. Chorus posted ${n} intervention${n === 1 ? "" : "s"}; mode is back to ${s.mode}. ${summarizeObligations(openObligations(s))}`,
  );
}
