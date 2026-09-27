import type pg from 'pg';
import {
  ChorusError,
  deliverPurchase,
  findPurchase,
  findRefund,
  purchaseFingerprint,
  quotePurchase,
  recordRefundSent,
  recordVerificationFailure,
  voidPurchase,
  withReadTx,
  type ArenaService,
  type CommandContext,
  type DeliveredResponse,
  type JsonValue,
  type Purchase,
  type PurchaseEffect,
  type PurchaseRefund,
  type ReadContext,
  type Uuid,
} from '@chorus/domain';
import {
  createHttpLedgerClient,
  LedgerUnavailableError,
  verifyPayment,
  type LedgerClient,
} from '@chorus/sharednet-ledger';
import { openSecret } from '../secrets.ts';

/** The room a purchase is made in, as a ledger factory needs to know it. */
export interface ArenaRoom {
  readonly workspaceId: Uuid;
  readonly actorId: Uuid;
  readonly roomId: Uuid;
  /** The SharedNet room id (`rom_…`) the payment must name. */
  readonly externalRoomId: string;
}

export interface ArenaDeps {
  readonly pool: pg.Pool;
  readonly sharednetBaseUrl: string;
  /** The ledger to verify against. Production: {@link createLedgerFor}; tests inject a fake. */
  readonly ledgerFor: (room: ArenaRoom) => Promise<LedgerClient> | LedgerClient;
  /** Overall budget for one verification (default 15 s). */
  readonly verifyTimeoutMs?: number;
}

export interface PurchaseRequest {
  /** `^[A-Za-z0-9._:-]{1,100}$`. The buyer-visible idempotency of a paid call. */
  readonly requestId: string;
  /** `^txn_[A-Za-z0-9]{6,64}$`; absent on the first call. */
  readonly paymentTxnId?: string | undefined;
  readonly target: { readonly sessionId?: Uuid; readonly boardId?: Uuid };
  /** The service input WITHOUT `request_id` and `payment_txn_id`. */
  readonly input: JsonValue;
  readonly amount: number;
  /** For an effect that changes the session itself: deliver under a session lock at this version. */
  readonly sessionLock?: { readonly expectedVersion: number };
  /**
   * Runs on an existing QUOTED purchase once it is known to be this same request (fingerprint matched),
   * before payment is requested or verified: throw to refuse a quote that no longer holds.
   */
  readonly checkQuoted?: (quoted: Purchase) => void;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const TXN_ID = /^txn_[A-Za-z0-9]{6,64}$/;
const VERIFY_OPTIONS = { maxPages: 5, pageSize: 100, ageSlackMs: 60_000 } as const;
const VERIFY_BUDGET_MS = 15_000;
const NOT_FOUND_RETRY_SECONDS = 5;

/**
 * The production ledger: the payee seat's token is read through `chorus_arena_payee` (only for a live member
 * of the room), opened with the secrets key in memory, and used for one client. It is never logged, stored
 * or put in an error.
 */
export function createLedgerFor(
  pool: pg.Pool,
  secretsKey: Buffer,
  sharednetBaseUrl: string,
): ArenaDeps['ledgerFor'] {
  return async (room) => {
    const seat = await withReadTx(
      { pool, workspaceId: room.workspaceId, actorId: room.actorId },
      async (db) => {
        const { rows } = await db.query<{
          token_ciphertext: Buffer;
          token_nonce: Buffer;
          key_id: string;
        }>('SELECT token_ciphertext, token_nonce, key_id FROM chorus_arena_payee($1)', [
          room.roomId,
        ]);
        return rows[0];
      },
    );
    if (seat === undefined)
      throw new ChorusError('room_not_available', 'The room is not available.');
    const token = openSecret(secretsKey, {
      ciphertext: seat.token_ciphertext,
      nonce: seat.token_nonce,
      keyId: seat.key_id,
    });
    return createHttpLedgerClient({ baseUrl: sharednetBaseUrl, token, timeoutMs: 5000 });
  };
}

/**
 * One paid call (WP5-min sections 3-5, Arena rev 2 section 1). In order: validate the shape; resolve the
 * proven seat of the caller; answer from an existing purchase (a conflicting request, a stored delivery, the
 * same quote again); otherwise quote; and when a payment is presented, verify it against the ledger OUTSIDE
 * any transaction and only then deliver in one. Throws `payment_required` (with the quote), or one of the
 * payment errors, or returns the delivered response.
 */
export async function purchase(
  deps: ArenaDeps,
  ctx: CommandContext,
  service: ArenaService,
  request: PurchaseRequest,
  effect: PurchaseEffect,
): Promise<DeliveredResponse> {
  // 1. Shape.
  if (!REQUEST_ID.test(request.requestId)) {
    throw new ChorusError('invalid_request', 'request_id must match ^[A-Za-z0-9._:-]{1,100}$.');
  }
  if (request.paymentTxnId !== undefined && !TXN_ID.test(request.paymentTxnId)) {
    throw new ChorusError('invalid_request', 'payment_txn_id must match ^txn_[A-Za-z0-9]{6,64}$.');
  }
  if (!Number.isInteger(request.amount) || request.amount < 1) {
    throw new ChorusError('invalid_request', 'The amount must be a positive integer.');
  }
  if (ctx.roomId === undefined) throw new ChorusError('invalid_request', 'The caller has no room.');
  const roomId = ctx.roomId;
  const read: ReadContext = { pool: deps.pool, workspaceId: ctx.workspaceId, actorId: ctx.actorId };
  const cmd: CommandContext = { ...ctx, pool: deps.pool };

  // 2. The seat the payment must come from (Arena rev 2 C1).
  const requesterSeat = await requesterSeatOf(read, ctx.instanceId);
  const sessionId = request.target.sessionId ?? null;
  const boardId = request.target.boardId ?? null;
  const fingerprint = purchaseFingerprint({
    service,
    workspaceId: ctx.workspaceId,
    roomId,
    sessionId,
    boardId,
    actorId: ctx.actorId,
    requesterMemberId: requesterSeat,
    input: request.input,
  });

  // 3. An existing purchase answers the common repeat cases without touching the ledger.
  const existing = await findPurchase(read, service, request.requestId);
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) {
      throw new ChorusError(
        'request_conflict',
        'This request_id was already used for a different request.',
      );
    }
    if (existing.state === 'delivered' && existing.txn_id !== null) {
      // Replays through the same command that delivered it, so the caller's CURRENT room membership and
      // session roles are re-checked and the stored response is returned without a charge.
      return deliverPurchase(cmd, {
        purchase: existing,
        txn_id: existing.txn_id,
        effect: neverRun,
      });
    }
    if (existing.state === 'voided') {
      throw new ChorusError(
        'invalid_transition',
        'This purchase was voided and its payment refunded.',
        {
          details: { reason: 'purchase_voided' },
        },
      );
    }
    try {
      request.checkQuoted?.(existing);
    } catch (error) {
      throw request.paymentTxnId === undefined
        ? error
        : withVoidHint(error, existing, request.paymentTxnId);
    }
    return settle(deps, cmd, read, existing, request.paymentTxnId, effect, request.sessionLock);
  }

  // 4. No purchase yet: quote it.
  const payee = await payeeOf(read, roomId);
  const quoted = await quotePurchase(cmd, {
    service,
    request_id: request.requestId,
    target: {
      ...(sessionId === null ? {} : { session_id: sessionId }),
      ...(boardId === null ? {} : { board_id: boardId }),
    },
    input: request.input,
    amount: request.amount,
    payee,
    requester_member_id: requesterSeat,
  });
  return settle(deps, cmd, read, quoted, request.paymentTxnId, effect, request.sessionLock);
}

/** A `quoted` purchase: ask for payment, or verify the payment that was presented and deliver. */
async function settle(
  deps: ArenaDeps,
  cmd: CommandContext,
  read: ReadContext,
  quoted: Purchase,
  txnId: string | undefined,
  effect: PurchaseEffect,
  sessionLock: PurchaseRequest['sessionLock'],
): Promise<DeliveredResponse> {
  const externalRoomId = await externalRoomIdOf(read, quoted.room_id as Uuid);
  if (txnId === undefined) throw paymentRequired(deps, quoted, externalRoomId);

  await verifyFor(deps, cmd, read, quoted, txnId, externalRoomId);
  try {
    return await deliverPurchase(cmd, {
      purchase: quoted,
      txn_id: txnId,
      effect,
      ...(sessionLock === undefined ? {} : { sessionLock }),
    });
  } catch (error) {
    throw withVoidHint(error, quoted, txnId);
  }
}

/**
 * Verifies that `txnId` pays exactly for `quoted`, against the ledger and OUTSIDE any transaction (no pooled
 * connection is held while it runs). Returns when verified; otherwise throws the buyer-facing payment error,
 * recording why a present-but-wrong payment was refused.
 */
async function verifyFor(
  deps: ArenaDeps,
  cmd: CommandContext,
  read: ReadContext,
  quoted: Purchase,
  txnId: string,
  externalRoomId: string,
): Promise<void> {
  const ledger = await ledgerOf(deps, read, quoted, externalRoomId);
  const verdict = await verifyPayment(
    ledger,
    {
      txnId,
      payeePrincipalId: quoted.payee_principal_id,
      payeeMemberId: quoted.payee_member_id,
      requesterMemberId: quoted.requester_member_id,
      roomId: externalRoomId,
      amount: quoted.amount,
      memo: quoted.memo,
      quoteCreatedAt: new Date(quoted.created_at),
    },
    VERIFY_OPTIONS,
    AbortSignal.timeout(deps.verifyTimeoutMs ?? VERIFY_BUDGET_MS),
  );
  switch (verdict.status) {
    case 'verified':
      return;
    case 'not_found':
      throw new ChorusError('payment_not_found', 'The payment is not visible in the ledger yet.', {
        details: {
          retry_after_seconds: NOT_FOUND_RETRY_SECONDS,
          pages_scanned: verdict.pagesScanned,
        },
      });
    case 'unavailable':
      throw new ChorusError('temporarily_unavailable', 'The SharedNet ledger is unavailable.', {
        details: { cause: verdict.cause },
      });
    case 'not_verified':
      await recordVerificationFailure(cmd, {
        purchase: quoted,
        txn_id: txnId,
        reason: verdict.reason,
        observed: { ...verdict.observed },
      });
      throw new ChorusError('payment_not_verified', 'The payment does not match this purchase.', {
        details: { reason: verdict.reason },
      });
  }
}

const ledgerOf = async (
  deps: ArenaDeps,
  read: ReadContext,
  purchase: Purchase,
  externalRoomId: string,
): Promise<LedgerClient> =>
  deps.ledgerFor({
    workspaceId: read.workspaceId,
    actorId: read.actorId,
    roomId: purchase.room_id as Uuid,
    externalRoomId,
  });

/**
 * A paid delivery that was refused for good (not a transient error, not a payment another purchase holds)
 * keeps its payment unspent, so the refusal tells the buyer both ways out: retry, or void for a refund.
 */
function withVoidHint(error: unknown, quoted: Purchase, txnId: string): unknown {
  if (
    !(error instanceof ChorusError) ||
    error.retryable ||
    error.code === 'internal_error' ||
    error.code === 'payment_already_used' ||
    (error.code === 'invalid_transition' && error.details['reason'] === 'purchase_voided')
  )
    return error;
  return new ChorusError(error.code, error.message, {
    cause: error,
    details: {
      ...error.details,
      refund_available: {
        tool: 'chorus.void_purchase',
        arguments: {
          service: quoted.service,
          request_id: quoted.request_id,
          payment_txn_id: txnId,
        },
        note: 'Your payment is not spent. Retry if the refusal can be fixed, or void the purchase to get the credits back.',
      },
    },
  });
}

/** What `chorus.void_purchase` returns: the voided purchase and where its refund stands. */
export type VoidedResponse = {
  state: 'VOIDED';
  service: ArenaService;
  request_id: string;
  purchase_id: string;
  amount: number;
  txn_id: string;
  refund: {
    state: 'sent' | 'pending';
    amount: number;
    to_member_id: string;
    refund_txn_id: string | null;
    sent_at: string | null;
    /** Why a pending refund was not sent yet; calling void_purchase again retries it. */
    pending_cause?: string;
  };
};

const REFUND_BUDGET_MS = 10_000;

/**
 * Voids a paid purchase that was never delivered, and refunds it (the refund/void path). The purchase must be
 * the caller's own and `payment_txn_id` must verify as its payment, exactly as for a delivery. Voiding is
 * final: the purchase can no longer be delivered and the payment can buy nothing else. The refund is sent
 * from the room's payee seat to the seat that paid, with one SharedNet Idempotency-Key per purchase, so
 * calling this again (for example after a network failure left the refund pending) never pays twice.
 */
export async function voidAndRefund(
  deps: ArenaDeps,
  ctx: CommandContext,
  service: ArenaService,
  requestId: string,
  paymentTxnId: string,
): Promise<VoidedResponse> {
  if (!REQUEST_ID.test(requestId)) {
    throw new ChorusError('invalid_request', 'request_id must match ^[A-Za-z0-9._:-]{1,100}$.');
  }
  if (!TXN_ID.test(paymentTxnId)) {
    throw new ChorusError('invalid_request', 'payment_txn_id must match ^txn_[A-Za-z0-9]{6,64}$.');
  }
  const read: ReadContext = { pool: deps.pool, workspaceId: ctx.workspaceId, actorId: ctx.actorId };
  const cmd: CommandContext = { ...ctx, pool: deps.pool };
  const existing = await findPurchase(read, service, requestId);
  if (existing === undefined) throw new ChorusError('not_found', 'Not found.');
  if (existing.state === 'delivered') {
    throw new ChorusError('invalid_transition', 'A delivered purchase cannot be voided.', {
      details: { reason: 'delivered' },
    });
  }
  const externalRoomId = await externalRoomIdOf(read, existing.room_id as Uuid);
  let refund: PurchaseRefund;
  if (existing.state === 'voided') {
    if (existing.txn_id !== paymentTxnId) throw alreadyVoided();
    const stored = await findRefund(read, existing.id);
    if (stored === undefined)
      throw new ChorusError('internal_error', 'A voided purchase has no refund.');
    refund = stored;
  } else {
    await verifyFor(deps, cmd, read, existing, paymentTxnId, externalRoomId);
    refund = await voidPurchase(cmd, {
      purchase: existing,
      txn_id: paymentTxnId,
      reason: 'buyer_voided',
    });
  }

  let pendingCause: string | undefined;
  if (refund.refund_txn_id === null) {
    // Sending talks to the network: outside any transaction, and recorded only after SharedNet accepted it.
    try {
      const ledger = await ledgerOf(deps, read, existing, externalRoomId);
      if (ledger.transfer === undefined) {
        pendingCause = 'refunds_unsupported';
      } else {
        const sent = await ledger.transfer(
          {
            to: refund.to_member_id,
            amount: refund.amount,
            memo: `chorus:v1:refund:${existing.id}`,
            roomId: externalRoomId,
            idempotencyKey: refund.transfer_key,
          },
          AbortSignal.timeout(REFUND_BUDGET_MS),
        );
        refund = await recordRefundSent(cmd, { purchase_id: existing.id, refund_txn_id: sent.id });
      }
    } catch (error) {
      if (error instanceof LedgerUnavailableError) pendingCause = error.cause_code;
      else if (error instanceof ChorusError && error.code === 'room_not_available')
        pendingCause = 'room_not_available';
      else throw error;
    }
  }
  return {
    state: 'VOIDED',
    service: existing.service,
    request_id: existing.request_id,
    purchase_id: existing.id,
    amount: existing.amount,
    txn_id: refund.txn_id,
    refund: {
      state: refund.refund_txn_id === null ? 'pending' : 'sent',
      amount: refund.amount,
      to_member_id: refund.to_member_id,
      refund_txn_id: refund.refund_txn_id,
      sent_at: refund.sent_at,
      ...(pendingCause === undefined ? {} : { pending_cause: pendingCause }),
    },
  };
}

const alreadyVoided = (): ChorusError =>
  new ChorusError('payment_already_used', 'This purchase was voided with a different payment.');

const neverRun: PurchaseEffect = () => {
  throw new ChorusError('internal_error', 'A delivered purchase must never re-run its effect.');
};

/** `payment_required` with everything the buyer needs to pay (WP5-min section 6), verbatim. */
function paymentRequired(deps: ArenaDeps, quoted: Purchase, externalRoomId: string): ChorusError {
  return new ChorusError('payment_required', 'Payment is required before this can be delivered.', {
    details: {
      state: 'PAYMENT_REQUIRED',
      service: quoted.service,
      request_id: quoted.request_id,
      purchase_id: quoted.id,
      amount: quoted.amount,
      currency: 'sharednet_credits',
      payee: { member_id: quoted.payee_member_id, principal_id: quoted.payee_principal_id },
      room_id: externalRoomId,
      memo: quoted.memo,
      pay_from_seat: quoted.requester_member_id,
      instruction: {
        method: 'POST',
        url: `${deps.sharednetBaseUrl}/api/v1/credits/transfers`,
        headers: {
          Authorization: 'Bearer <YOUR SEAT member_token (sni_…), not an account key>',
          'Idempotency-Key': '<one UUID you generate for this request_id and reuse on every retry>',
          'Content-Type': 'application/json',
        },
        body: {
          to: quoted.payee_member_id,
          amount: quoted.amount,
          memo: quoted.memo,
          room_id: externalRoomId,
        },
      },
      then: 'call this tool again with the same arguments plus payment_txn_id = transfer.id from the 201 response',
      warning:
        "Do not use a CLI 'pay' retry; it generates a new idempotency key per call and can pay twice. Payments are final once delivered; a paid purchase that cannot be delivered can be voided with chorus.void_purchase for a refund.",
    },
  });
}

/** The seat the caller's enrollment PROVED. An instance enrolled before 0007 has none and must re-enroll. */
async function requesterSeatOf(read: ReadContext, instanceId: Uuid | null): Promise<string> {
  const seat =
    instanceId === null
      ? undefined
      : await withReadTx(read, async (db) => {
          const { rows } = await db.query<{ sharednet_member_id: string | null }>(
            'SELECT sharednet_member_id FROM agent_instances WHERE workspace_id = $1 AND id = $2',
            [read.workspaceId, instanceId],
          );
          return rows[0]?.sharednet_member_id ?? undefined;
        });
  if (seat === undefined) {
    throw new ChorusError(
      'action_forbidden',
      'Re-enroll before buying: your seat is not recorded.',
      {
        details: { reason: 'reenroll_required' },
      },
    );
  }
  return seat;
}

async function payeeOf(
  read: ReadContext,
  roomId: Uuid,
): Promise<{ member_id: string; principal_id: string }> {
  const payee = await withReadTx(read, async (db) => {
    const { rows } = await db.query<{ member_id: string; principal_id: string }>(
      'SELECT member_id, principal_id FROM chorus_arena_payee($1)',
      [roomId],
    );
    return rows[0];
  });
  if (payee === undefined)
    throw new ChorusError('room_not_available', 'The room is not available.');
  return payee;
}

async function externalRoomIdOf(read: ReadContext, roomId: Uuid): Promise<string> {
  const external = await withReadTx(read, async (db) => {
    const { rows } = await db.query<{ external_room_id: string | null }>(
      'SELECT external_room_id FROM rooms WHERE workspace_id = $1 AND id = $2',
      [read.workspaceId, roomId],
    );
    return rows[0]?.external_room_id ?? undefined;
  });
  if (external === undefined)
    throw new ChorusError('room_not_available', 'The room is not available.');
  return external;
}
