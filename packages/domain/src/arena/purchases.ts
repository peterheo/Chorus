import { requireAction } from '../authz.ts';
import {
  runCommand,
  withReadTx,
  type CommandContext,
  type CommandTx,
  type DomainEventDraft,
  type JsonValue,
  type ReadContext,
} from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';
import { purchaseFingerprint, purchaseMemo, type ArenaService } from './fingerprint.ts';

/**
 * Purchases for the paid Arena services (WP5-min rev 1 sections 2-5, Arena rev 2). Pure database: nothing
 * here talks to SharedNet. Ledger verification happens in the API layer, BEFORE `deliverPurchase`, so no
 * network call is ever made while a transaction is open.
 */

export type DeliveredResponse = {
  state: 'DELIVERED';
  service: ArenaService;
  request_id: string;
  purchase_id: string;
  amount: number;
  txn_id: string;
  result: JsonValue;
};

export type Purchase = {
  id: string;
  room_id: string;
  session_id: string | null;
  board_id: string | null;
  actor_id: string;
  requester_member_id: string;
  service: ArenaService;
  request_id: string;
  fingerprint: string;
  amount: number;
  payee_member_id: string;
  payee_principal_id: string;
  memo: string;
  state: 'quoted' | 'delivered';
  created_at: string;
  delivered_at: string | null;
  txn_id: string | null;
  response: DeliveredResponse | null;
};

/** What a delivery effect returns: the buyer-visible result and the domain events of what it created. */
export type PurchaseEffectResult = { result: JsonValue; events: readonly DomainEventDraft[] };
export type PurchaseEffect = (tx: CommandTx) => Promise<PurchaseEffectResult>;

export interface QuoteArgs {
  readonly service: ArenaService;
  readonly request_id: string;
  readonly target: { readonly session_id?: Uuid; readonly board_id?: Uuid };
  /** The service input WITHOUT `request_id` and `payment_txn_id`. */
  readonly input: JsonValue;
  readonly amount: number;
  readonly payee: { readonly member_id: string; readonly principal_id: string };
  readonly requester_member_id: string;
}

type PurchaseRow = Omit<Purchase, 'created_at' | 'delivered_at'> & {
  created_at: Date;
  delivered_at: Date | null;
};

const COLUMNS = `id, room_id, session_id, board_id, actor_id, requester_member_id, service, request_id,
  fingerprint, amount, payee_member_id, payee_principal_id, memo, state, created_at, delivered_at, txn_id,
  response`;

const toPurchase = (row: PurchaseRow): Purchase => ({
  ...row,
  created_at: row.created_at.toISOString(),
  delivered_at: row.delivered_at === null ? null : row.delivered_at.toISOString(),
});

const notFound = (): ChorusError => new ChorusError('not_found', 'Not found.');

/** A live member of the (active) room the command runs in. */
async function requireRoomMember(tx: CommandTx, roomId: Uuid | undefined): Promise<Uuid> {
  if (roomId === undefined) throw new ChorusError('invalid_request', 'The caller has no room.');
  const member = await tx.db.query(
    `SELECT 1 FROM room_members m JOIN rooms r ON r.workspace_id = m.workspace_id AND r.id = m.room_id
      WHERE m.workspace_id = $1 AND m.room_id = $2 AND m.actor_id = $3 AND m.removed_at IS NULL
        AND r.activation_state = 'active'`,
    [tx.workspaceId, roomId, tx.actorId],
  );
  if (member.rowCount === 0) throw notFound();
  return roomId;
}

/**
 * Quotes a purchase: the first call for (actor, service, request_id) stores a `quoted` row with the canonical
 * memo. It goes through `runCommand` (the single write path) with the idempotency key
 * `arena-quote:<service>:<request_id>`; a changed input under the same request_id changes the request hash,
 * which `runCommand` reports as `idempotency_conflict`, and that one case is translated to `request_conflict`.
 * A quote changes no domain state, so it is journaled as a no-op (the purchases row is the record).
 */
export async function quotePurchase(ctx: CommandContext, args: QuoteArgs): Promise<Purchase> {
  const { service } = args;
  const sessionId = args.target.session_id ?? null;
  const boardId = args.target.board_id ?? null;
  if (ctx.roomId === undefined) throw new ChorusError('invalid_request', 'The caller has no room.');
  const roomId = ctx.roomId;
  if ((service === 'create_tasks') !== (sessionId !== null && boardId !== null)) {
    throw new ChorusError(
      'invalid_request',
      service === 'create_tasks'
        ? 'create_tasks needs a session_id and a board_id.'
        : 'create_action_board takes no session_id or board_id.',
    );
  }
  const fingerprint = purchaseFingerprint({
    service,
    workspaceId: ctx.workspaceId,
    roomId,
    sessionId,
    boardId,
    actorId: ctx.actorId,
    requesterMemberId: args.requester_member_id,
    input: args.input,
  });

  try {
    return await runCommand<Purchase>(
      { ...ctx, idempotencyKey: `arena-quote:${service}:${args.request_id}` },
      {
        type: 'arena.quote',
        input: { service, request_id: args.request_id, fingerprint },
        authorize: async (tx) => {
          await requireRoomMember(tx, roomId);
          if (sessionId === null) return;
          // create_tasks: the buyer must be able to create items in the target session, and the board must be
          // that session's (a non-member learns nothing: not_found).
          const roles = await tx.db.query<{ roles: string[] | null }>(
            'SELECT chorus_session_roles($1) AS roles',
            [sessionId],
          );
          const held = roles.rows[0]?.roles;
          if (held === null || held === undefined) throw notFound();
          requireAction(
            { roles: held as ('participant' | 'manager' | 'administrator')[] },
            'create_item',
          );
          const board = await tx.db.query(
            'SELECT 1 FROM projects WHERE workspace_id = $1 AND id = $2 AND session_id = $3',
            [tx.workspaceId, boardId, sessionId],
          );
          if (board.rowCount === 0) throw notFound();
        },
        handle: async (tx) => {
          const minted = await tx.db.query<{ id: string }>('SELECT uuidv7() AS id');
          const id = minted.rows[0]?.id;
          if (id === undefined) throw new ChorusError('internal_error', 'No purchase id.');
          const inserted = await tx.db.query<PurchaseRow>(
            `INSERT INTO purchases
               (id, workspace_id, room_id, session_id, board_id, actor_id, requester_member_id, service,
                request_id, fingerprint, amount, payee_member_id, payee_principal_id, memo, state)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'quoted')
             RETURNING ${COLUMNS}`,
            [
              id,
              tx.workspaceId,
              roomId,
              sessionId,
              boardId,
              tx.actorId,
              args.requester_member_id,
              service,
              args.request_id,
              fingerprint,
              args.amount,
              args.payee.member_id,
              args.payee.principal_id,
              purchaseMemo(service, id),
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined)
            throw new ChorusError('internal_error', 'The quote was not stored.');
          return { result: toPurchase(row), events: [], noop: true };
        },
      },
    );
  } catch (error) {
    if (error instanceof ChorusError && error.code === 'idempotency_conflict') {
      throw new ChorusError(
        'request_conflict',
        'This request_id was already used for a different request.',
      );
    }
    throw error;
  }
}

/** The caller's own purchase for (service, request_id), if any (row-level security scopes it to them). */
export async function findPurchase(
  ctx: ReadContext,
  service: ArenaService,
  requestId: string,
): Promise<Purchase | undefined> {
  return withReadTx(ctx, async (db) => {
    const { rows } = await db.query<PurchaseRow>(
      `SELECT ${COLUMNS} FROM purchases
        WHERE workspace_id = $1 AND actor_id = $2 AND service = $3 AND request_id = $4`,
      [ctx.workspaceId, ctx.actorId, service, requestId],
    );
    const row = rows[0];
    return row === undefined ? undefined : toPurchase(row);
  });
}

/**
 * Delivers a verified purchase in ONE transaction (via `runCommand`, key `arena:<purchase_id>`): lock the
 * purchase, return the stored response if it is already delivered, refuse a txn another purchase holds, run
 * the effect, and flip the purchase to delivered with the txn and the stored response in a single UPDATE.
 * Any throw rolls back everything: the purchase stays `quoted` and the txn unclaimed, so a retry with the
 * same txn works. A repeat of a delivered purchase replays the stored response after re-authorizing the
 * caller's CURRENT room membership and session roles.
 *
 * `create_tasks` deliveries are session-scoped (membership and roles are checked, and re-checked on replay);
 * `create_action_board` is room-level.
 */
export async function deliverPurchase(
  ctx: CommandContext,
  args: { readonly purchase: Purchase; readonly txn_id: string; readonly effect: PurchaseEffect },
): Promise<DeliveredResponse> {
  const { purchase, txn_id: txnId, effect } = args;
  const sessionId = purchase.session_id;
  return runCommand<DeliveredResponse>(
    { ...ctx, idempotencyKey: `arena:${purchase.id}` },
    {
      type: 'arena.deliver',
      // Only the purchase is hashed, not the txn: concurrent deliveries of one purchase with different txns
      // are the same command, so the loser replays the stored DELIVERED response instead of an
      // idempotency_conflict that means nothing to a buyer (paid tools have no idempotency key). Reuse of a
      // txn is refused in the handler (pre-check + UNIQUE), not by the command hash.
      input: { purchase_id: purchase.id },
      ...(sessionId === null ? {} : { session: { id: sessionId as Uuid } }),
      authorize: async (tx) => {
        await requireRoomMember(tx, ctx.roomId);
        if (sessionId !== null) requireAction(tx, 'create_item');
      },
      handle: async (tx) => {
        const locked = await tx.db.query<PurchaseRow>(
          `SELECT ${COLUMNS} FROM purchases WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [tx.workspaceId, purchase.id],
        );
        const row = locked.rows[0];
        if (row === undefined) throw notFound();
        if (row.state === 'delivered' && row.response !== null) {
          return { result: row.response, events: [], noop: true };
        }
        // Fast refusal when this buyer already spent the txn on another purchase; the UNIQUE index on
        // txn_id still arbitrates every race (and every buyer), below.
        const used = await tx.db.query('SELECT 1 FROM purchases WHERE txn_id = $1 AND id <> $2', [
          txnId,
          purchase.id,
        ]);
        if (used.rowCount !== 0) throw alreadyUsed();

        const effected = await effect(tx);
        const events = withPurchaseProvenance(effected.events, {
          purchase_id: purchase.id,
          service: purchase.service,
          amount: purchase.amount,
          txn_id: txnId,
        });
        const response: DeliveredResponse = {
          state: 'DELIVERED',
          service: purchase.service,
          request_id: purchase.request_id,
          purchase_id: purchase.id,
          amount: purchase.amount,
          txn_id: txnId,
          result: effected.result,
        };
        try {
          await tx.db.query(
            `UPDATE purchases
                SET state = 'delivered', txn_id = $3, response = $4::jsonb, delivered_at = now()
              WHERE workspace_id = $1 AND id = $2`,
            [tx.workspaceId, purchase.id, txnId, JSON.stringify(response)],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23505') throw alreadyUsed();
          throw error;
        }
        return { result: response, events };
      },
    },
  );
}

const alreadyUsed = (): ChorusError =>
  new ChorusError('payment_already_used', 'This payment was already used for another purchase.');

/**
 * Records which purchase created what, on the FIRST created aggregate's creation event. It is data on that
 * event, not an event of its own: a separate event would need an aggregate version of its own, which the
 * aggregate's next real command would then collide with.
 */
function withPurchaseProvenance(
  events: readonly DomainEventDraft[],
  purchase: { purchase_id: string; service: ArenaService; amount: number; txn_id: string },
): DomainEventDraft[] {
  const [first, ...rest] = events;
  if (first === undefined) return [];
  return [{ ...first, payload: { ...first.payload, purchase } }, ...rest];
}

/**
 * Records why a payment was refused (exactly the ten CreditTransfer fields the ledger returned; never a
 * token). Through `runCommand` with key `arena-fail:<purchase_id>:<txn_id>`, so repeating the same refusal
 * writes one row.
 */
export async function recordVerificationFailure(
  ctx: CommandContext,
  args: {
    readonly purchase: Purchase;
    readonly txn_id: string;
    readonly reason: 'payee' | 'payer_seat' | 'room' | 'amount' | 'memo' | 'age';
    readonly observed: { readonly [key: string]: JsonValue };
  },
): Promise<void> {
  await runCommand<{ recorded: true }>(
    { ...ctx, idempotencyKey: `arena-fail:${args.purchase.id}:${args.txn_id}` },
    {
      type: 'arena.verification_failed',
      input: { purchase_id: args.purchase.id, txn_id: args.txn_id },
      authorize: async (tx) => {
        await requireRoomMember(tx, ctx.roomId);
      },
      handle: async (tx) => {
        await tx.db.query(
          `INSERT INTO payment_verification_failures
             (workspace_id, actor_id, purchase_id, txn_id, reason, observed)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            tx.workspaceId,
            tx.actorId,
            args.purchase.id,
            args.txn_id,
            args.reason,
            JSON.stringify(args.observed),
          ],
        );
        return { result: { recorded: true }, events: [], noop: true };
      },
    },
  );
}
