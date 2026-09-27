import type pg from 'pg';
import {
  ChorusError,
  deliverPurchase,
  findPurchase,
  purchaseFingerprint,
  quotePurchase,
  recordVerificationFailure,
  withReadTx,
  type ArenaService,
  type CommandContext,
  type DeliveredResponse,
  type JsonValue,
  type Purchase,
  type PurchaseEffect,
  type ReadContext,
  type Uuid,
} from '@chorus/domain';
import { createHttpLedgerClient, verifyPayment, type LedgerClient } from '@chorus/sharednet-ledger';
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
    request.checkQuoted?.(existing);
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

  // Verification talks to the network: no transaction and no pooled connection is held while it runs.
  const ledger = await deps.ledgerFor({
    workspaceId: read.workspaceId,
    actorId: read.actorId,
    roomId: quoted.room_id as Uuid,
    externalRoomId,
  });
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
      return deliverPurchase(cmd, {
        purchase: quoted,
        txn_id: txnId,
        effect,
        ...(sessionLock === undefined ? {} : { sessionLock }),
      });
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
        "Do not use a CLI 'pay' retry; it generates a new idempotency key per call and can pay twice. Payments are final.",
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
