import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChorusError,
  deliverPurchase,
  findPurchase,
  quotePurchase,
  type CommandContext,
  type DeliveredResponse,
  type Purchase,
  type PurchaseEffect,
  type Uuid,
} from '@chorus/domain';
import type { CreditTransfer, LedgerClient } from '@chorus/sharednet-ledger';
import {
  createFakeLedgerClient,
  sampleTransfer,
  startFakeLedgerServer,
} from '@chorus/sharednet-ledger/testing';
import {
  createFixture,
  type Actor,
  type Fixture,
  type SessionSeed,
} from '../../../../packages/domain/test/helpers/fixture.ts';
import { createLedgerFor, purchase, type ArenaDeps } from '../../src/arena/payments.ts';
import { sealSecret } from '../../src/secrets.ts';

const BASE = 'https://www.sharednet.ai';

interface World {
  ws: Actor['ws'];
  external: string;
  payee: { memberId: string; principalId: string };
  buyer: Actor;
  seat: string;
  session: SessionSeed;
}

describe('arena purchases: quote, verify outside the transaction, deliver atomically (real PostgreSQL as chorus_app, fake ledger)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture({ poolMax: 24 });
  });
  afterAll(async () => {
    await f.close();
  });

  let n = 0;
  const tag = () => `${String(++n).padStart(4, '0')}${randomBytes(3).toString('hex')}`;

  /** A workspace whose room is bound to SharedNet (a payee seat exists), and a buyer whose seat was proven. */
  async function world(label: string): Promise<World> {
    const ws = await f.workspace(`${label}-${tag()}`);
    const external = `rom_${tag()}Room`;
    const payee = { memberId: `i_Payee${tag()}`, principalId: `p_Payee${tag()}` };
    await f.owner(`UPDATE rooms SET provider = 'sharednet', external_room_id = $2 WHERE id = $1`, [
      ws.roomId,
      external,
    ]);
    await f.owner(
      `INSERT INTO sharednet_seats (workspace_id, room_id, member_id, principal_id, token_ciphertext, token_nonce, key_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'abcdef01')`,
      [ws.id, ws.roomId, payee.memberId, payee.principalId, Buffer.alloc(24), Buffer.alloc(12)],
    );
    const buyer = await buyerIn(ws, 'buyer');
    const session = await f.session(buyer);
    return { ws, external, payee, buyer, seat: await seatOf(buyer), session };
  }
  async function buyerIn(ws: Actor['ws'], label: string): Promise<Actor> {
    const actor = await f.actor(ws, `${label}-${tag()}`);
    await f.owner(`UPDATE agent_instances SET sharednet_member_id = $2 WHERE id = $1`, [
      actor.instanceId,
      `i_Seat${tag()}`,
    ]);
    return actor;
  }
  const seatOf = async (a: Actor): Promise<string> =>
    (
      await f.owner<{ s: string }>(
        `SELECT sharednet_member_id AS s FROM agent_instances WHERE id = $1`,
        [a.instanceId],
      )
    )[0]?.s ?? '';

  /** The delivery effect a tool supplies: creates `count` real tasks in the purchase's session. */
  const tasksEffect =
    (count: number, boardId: Uuid, counter?: { runs: number }): PurchaseEffect =>
    async (tx) => {
      if (counter !== undefined) counter.runs++;
      const session = tx.session;
      if (session === undefined) throw new Error('a session-scoped delivery is expected');
      const tasks: { id: string; title: string; version: number }[] = [];
      const events = [];
      for (let i = 0; i < count; i++) {
        const { rows } = await tx.db.query<{ id: Uuid }>(
          `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title, body, state, priority, creator_actor_id)
           VALUES ($1, $2, $3, 'task', $4, $5, '', 'ready', 2, $6) RETURNING id`,
          [tx.workspaceId, session.id, boardId, session.roomId, `task ${String(i)}`, tx.actorId],
        );
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('no task id');
        await tx.db.query(
          `INSERT INTO task_details (workspace_id, session_id, item_id, acceptance_criteria, criteria_revision, review_required, shareable, claim_policy)
           VALUES ($1, $2, $3, '["done"]'::jsonb, 1, true, false, $4)`,
          [tx.workspaceId, session.id, id, session.defaultClaimPolicy],
        );
        await tx.db.query(
          `INSERT INTO task_criteria_revisions (workspace_id, session_id, task_id, criteria_revision, acceptance_criteria, created_by)
           VALUES ($1, $2, $3, 1, '["done"]'::jsonb, $4)`,
          [tx.workspaceId, session.id, id, tx.actorId],
        );
        await tx.db.query(
          `INSERT INTO task_leases (workspace_id, session_id, task_id, fence) VALUES ($1, $2, $3, 0)`,
          [tx.workspaceId, session.id, id],
        );
        tasks.push({ id, title: `task ${String(i)}`, version: 1 });
        events.push({
          roomId: session.roomId,
          aggregateId: id,
          aggregateVersion: 1,
          eventType: 'task.created',
          payload: { title: `task ${String(i)}` },
        });
      }
      return { result: { tasks }, events };
    };

  const ledgerReturning = (...transfers: CreditTransfer[]): LedgerClient =>
    createFakeLedgerClient(transfers);
  const forbiddenLedger: LedgerClient = {
    listTransfers: () => Promise.reject(new Error('the ledger must not be consulted')),
  };
  const depsWith = (ledger: LedgerClient, pool: pg.Pool = f.pool): ArenaDeps => ({
    pool,
    sharednetBaseUrl: BASE,
    ledgerFor: () => ledger,
  });
  const ctxOf = (w: World, actor: Actor = w.buyer): CommandContext => ({
    pool: f.pool,
    workspaceId: w.ws.id,
    actorId: actor.id,
    instanceId: actor.instanceId,
    roomId: w.ws.roomId,
    idempotencyKey: undefined,
  });

  interface Call {
    w: World;
    requestId: string;
    count?: number;
    session?: SessionSeed;
    actor?: Actor;
    txn?: string | undefined;
    ledger?: LedgerClient;
    effect?: PurchaseEffect;
    counter?: { runs: number };
  }
  const buy = (c: Call): Promise<DeliveredResponse> => {
    const session = c.session ?? c.w.session;
    const count = c.count ?? 1;
    return purchase(
      depsWith(c.ledger ?? forbiddenLedger),
      ctxOf(c.w, c.actor),
      'create_tasks',
      {
        requestId: c.requestId,
        paymentTxnId: c.txn,
        target: { sessionId: session.id, boardId: session.boardId },
        input: { tasks: Array.from({ length: count }, (_, i) => ({ title: `task ${String(i)}` })) },
        amount: count,
      },
      c.effect ?? tasksEffect(count, session.boardId, c.counter),
    );
  };
  const quoteOf = async (c: Call): Promise<Record<string, unknown>> => {
    try {
      await buy({ ...c, txn: undefined });
    } catch (error) {
      if (error instanceof ChorusError && error.code === 'payment_required') return error.details;
      throw error;
    }
    throw new Error('expected payment_required');
  };
  const transferFor = (
    w: World,
    quote: Record<string, unknown>,
    over: Partial<CreditTransfer> = {},
    seat: string = w.seat,
  ): CreditTransfer =>
    sampleTransfer({
      id: `txn_${tag()}`,
      to_principal_id: w.payee.principalId,
      addressed_to: w.payee.memberId,
      by_instance_id: seat,
      room_id: w.external,
      amount: quote['amount'] as number,
      memo: quote['memo'] as string,
      created_at: new Date().toISOString(),
      ...over,
    });
  const tasksIn = (s: SessionSeed) =>
    f.count(`SELECT count(*) AS n FROM work_items WHERE session_id = $1 AND kind = 'task'`, [s.id]);
  const purchaseRow = async (id: string) =>
    (
      await f.owner<{ state: string; txn_id: string | null }>(
        `SELECT state, txn_id FROM purchases WHERE id = $1`,
        [id],
      )
    )[0];
  const expectCode = async (promise: Promise<unknown>, code: string, details?: object) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error, `expected ${code}`).toBeInstanceOf(ChorusError);
    expect((error as ChorusError).code).toBe(code);
    if (details !== undefined) expect((error as ChorusError).details).toMatchObject(details);
  };

  it('P1 arena.pay.happy_path: quote → pay → deliver; the response is stored and the tasks exist', async () => {
    const w = await world('p1');
    const quote = await quoteOf({ w, requestId: 'r-p1', count: 3 });
    expect(quote).toMatchObject({
      state: 'PAYMENT_REQUIRED',
      service: 'create_tasks',
      request_id: 'r-p1',
      amount: 3,
      currency: 'sharednet_credits',
      payee: { member_id: w.payee.memberId, principal_id: w.payee.principalId },
      room_id: w.external,
      pay_from_seat: w.seat,
      instruction: { method: 'POST', url: `${BASE}/api/v1/credits/transfers` },
    });
    expect(quote['memo']).toBe(`chorus:v1:create_tasks:${quote['purchase_id'] as string}`);
    expect(quote['warning']).toContain('Payments are final');
    // Asking again before paying returns the SAME quote (same purchase, same memo).
    expect(await quoteOf({ w, requestId: 'r-p1', count: 3 })).toMatchObject({
      purchase_id: quote['purchase_id'],
      memo: quote['memo'],
    });

    const transfer = transferFor(w, quote);
    const done = await buy({
      w,
      requestId: 'r-p1',
      count: 3,
      txn: transfer.id,
      ledger: ledgerReturning(transfer),
    });
    expect(done).toMatchObject({
      state: 'DELIVERED',
      service: 'create_tasks',
      request_id: 'r-p1',
      purchase_id: quote['purchase_id'],
      amount: 3,
      txn_id: transfer.id,
    });
    expect((done.result as { tasks: unknown[] }).tasks).toHaveLength(3);
    expect(await tasksIn(w.session)).toBe(3);
    expect(await purchaseRow(quote['purchase_id'] as string)).toEqual({
      state: 'delivered',
      txn_id: transfer.id,
    });
    // The first created task's creation event carries the purchase provenance; the others do not.
    const events = await f.owner<{
      payload: { purchase?: { purchase_id: string; txn_id: string; amount: number } };
    }>(
      `SELECT payload FROM domain_events WHERE session_id = $1 AND event_type = 'task.created' ORDER BY occurred_at, id`,
      [w.session.id],
    );
    // EVERY created task's creation event carries the purchase provenance.
    const provenance = {
      purchase_id: quote['purchase_id'],
      service: 'create_tasks',
      amount: 3,
      txn_id: transfer.id,
    };
    expect(events).toHaveLength(3);
    for (const event of events) expect(event.payload.purchase).toEqual(provenance);
    // Single write path: the quote and the delivery are commands, not ad-hoc writes.
    const commands = await f.owner<{ idempotency_key: string; command_type: string }>(
      `SELECT idempotency_key, command_type FROM commands WHERE workspace_id = $1 AND idempotency_key LIKE 'arena%'`,
      [w.ws.id],
    );
    expect(commands.map((c) => c.idempotency_key).sort()).toEqual(
      [`arena-quote:create_tasks:r-p1`, `arena:${quote['purchase_id'] as string}`].sort(),
    );
    expect(commands.map((c) => c.command_type).sort()).toEqual(['arena.deliver', 'arena.quote']);
  });

  it('P2 arena.pay.replay: a delivered purchase replays the stored response without the ledger or new work, and re-authorizes', async () => {
    const w = await world('p2');
    const quote = await quoteOf({ w, requestId: 'r-p2', count: 2 });
    const transfer = transferFor(w, quote);
    const first = await buy({
      w,
      requestId: 'r-p2',
      count: 2,
      txn: transfer.id,
      ledger: ledgerReturning(transfer),
    });
    const tasks = await tasksIn(w.session);
    const counter = { runs: 0 };
    // Same request again, with or without the txn: the ledger is never consulted and nothing is created.
    for (const txn of [transfer.id, undefined]) {
      const again = await buy({
        w,
        requestId: 'r-p2',
        count: 2,
        txn,
        ledger: forbiddenLedger,
        counter,
      });
      expect(again).toEqual(first);
    }
    expect(counter.runs).toBe(0);
    expect(await tasksIn(w.session)).toBe(tasks);
    // Once the buyer no longer participates in the session, the replay is refused with no body.
    await f.owner(
      `UPDATE session_members SET removed_at = now() WHERE session_id = $1 AND actor_id = $2`,
      [w.session.id, w.buyer.id],
    );
    await expectCode(buy({ w, requestId: 'r-p2', count: 2, txn: transfer.id }), 'not_found');
  });

  it('P3 arena.pay.checks: every field check fails on its own with the exact reason, and nothing is created', async () => {
    const w = await world('p3');
    const cases: [string, (q: Record<string, unknown>) => Partial<CreditTransfer>][] = [
      ['payee', () => ({ to_principal_id: 'p_SomebodyElse01' })],
      ['payee', () => ({ addressed_to: 'i_SomebodyElse01' })],
      ['payer_seat', () => ({ by_instance_id: null })],
      ['payer_seat', () => ({ by_instance_id: 'i_AnotherSeat01' })],
      ['room', () => ({ room_id: 'rom_SomeOtherRoom01' })],
      ['amount', (q) => ({ amount: (q['amount'] as number) + 1 })],
      ['amount', (q) => ({ amount: (q['amount'] as number) - 1 })],
      ['memo', (q) => ({ memo: `${q['memo'] as string}x` })],
      ['memo', (q) => ({ memo: (q['memo'] as string).slice(0, -1) })],
      ['age', () => ({ created_at: new Date(Date.now() - 5 * 60_000).toISOString() })],
    ];
    let i = 0;
    for (const [reason, mutate] of cases) {
      const requestId = `r-p3-${String(i++)}`;
      const quote = await quoteOf({ w, requestId, count: 2 });
      const transfer = transferFor(w, quote, mutate(quote));
      await expectCode(
        buy({ w, requestId, count: 2, txn: transfer.id, ledger: ledgerReturning(transfer) }),
        'payment_not_verified',
        { reason },
      );
      expect((await purchaseRow(quote['purchase_id'] as string))?.state).toBe('quoted');
    }
    expect(await tasksIn(w.session)).toBe(0);
    const failures = await f.owner<{ reason: string; observed: Record<string, unknown> }>(
      `SELECT reason, observed FROM payment_verification_failures WHERE workspace_id = $1`,
      [w.ws.id],
    );
    expect(failures).toHaveLength(cases.length);
    expect(failures.map((r) => r.reason).sort()).toEqual(cases.map(([r]) => r).sort());
    // `observed` holds exactly the ten CreditTransfer fields, nothing else.
    for (const row of failures) {
      expect(Object.keys(row.observed).sort()).toEqual(Object.keys(sampleTransfer()).sort());
    }
    // Repeating the same refusal writes no second row.
    const quote = await quoteOf({ w, requestId: 'r-p3-again', count: 1 });
    const bad = transferFor(w, quote, { amount: 99 });
    for (let k = 0; k < 3; k++) {
      await expectCode(
        buy({ w, requestId: 'r-p3-again', txn: bad.id, ledger: ledgerReturning(bad) }),
        'payment_not_verified',
      );
    }
    expect(
      await f.count(`SELECT count(*) AS n FROM payment_verification_failures WHERE txn_id = $1`, [
        bad.id,
      ]),
    ).toBe(1);
  });

  it("P4 arena.pay.stolen_receipt: another seat's payment cannot buy, and a spent txn cannot pay twice", async () => {
    const w = await world('p4');
    const other = await buyerIn(w.ws, 'other');
    await f.join(w.session, other);
    const otherSeat = await seatOf(other);
    // A pays and is delivered.
    const quoteA = await quoteOf({ w, requestId: 'r-p4-a', count: 1 });
    const paidA = transferFor(w, quoteA);
    await buy({ w, requestId: 'r-p4-a', txn: paidA.id, ledger: ledgerReturning(paidA) });
    // B presents A's txn for B's OWN purchase: the payer seat (and the memo) are not B's.
    const quoteB = await quoteOf({ w, requestId: 'r-p4-b', count: 1, actor: other });
    await expectCode(
      buy({ w, requestId: 'r-p4-b', actor: other, txn: paidA.id, ledger: ledgerReturning(paidA) }),
      'payment_not_verified',
      { reason: 'payer_seat' },
    );
    expect(otherSeat).not.toBe(w.seat);
    // Even a ledger view that (wrongly) shows A's txn as paying B's purchase cannot deliver it twice: the
    // UNIQUE txn claim refuses, and everything rolls back.
    const lying = transferFor(w, quoteB, { id: paidA.id }, otherSeat);
    await expectCode(
      buy({ w, requestId: 'r-p4-b', actor: other, txn: paidA.id, ledger: ledgerReturning(lying) }),
      'payment_already_used',
    );
    expect((await purchaseRow(quoteB['purchase_id'] as string))?.state).toBe('quoted');
    expect(await tasksIn(w.session)).toBe(1);
  });

  it('P5 arena.pay.cross_session: a payment for one session cannot deliver a request aimed at another', async () => {
    const w = await world('p5');
    const s2 = await f.session(w.buyer);
    const quote = await quoteOf({ w, requestId: 'r-p5', count: 1 });
    const transfer = transferFor(w, quote);
    // The same request_id aimed at the other session is a different request.
    await expectCode(
      buy({
        w,
        requestId: 'r-p5',
        session: s2,
        txn: transfer.id,
        ledger: ledgerReturning(transfer),
      }),
      'request_conflict',
    );
    // A separate purchase for S2 has its own memo; S1's txn does not match it.
    await quoteOf({ w, requestId: 'r-p5-s2', session: s2, count: 1 });
    await expectCode(
      buy({
        w,
        requestId: 'r-p5-s2',
        session: s2,
        txn: transfer.id,
        ledger: ledgerReturning(transfer),
      }),
      'payment_not_verified',
      { reason: 'memo' },
    );
    expect(await tasksIn(s2)).toBe(0);
    expect(await tasksIn(w.session)).toBe(0);
  });

  it('P6 arena.pay.request_mutation: the same request_id with a changed input is a request_conflict', async () => {
    const w = await world('p6');
    const quote = await quoteOf({ w, requestId: 'r-p6', count: 2 });
    await expectCode(buy({ w, requestId: 'r-p6', count: 3 }), 'request_conflict'); // while quoted
    const transfer = transferFor(w, quote);
    await buy({
      w,
      requestId: 'r-p6',
      count: 2,
      txn: transfer.id,
      ledger: ledgerReturning(transfer),
    });
    await expectCode(buy({ w, requestId: 'r-p6', count: 3 }), 'request_conflict'); // after delivery
    // The race outcome is the same one: the quote command itself reports it when the input changed.
    const base = {
      service: 'create_tasks' as const,
      request_id: 'r-p6-race',
      target: { session_id: w.session.id, board_id: w.session.boardId },
      amount: 1,
      payee: { member_id: w.payee.memberId, principal_id: w.payee.principalId },
      requester_member_id: w.seat,
    };
    await quotePurchase(ctxOf(w), { ...base, input: { a: 1 } });
    await expectCode(quotePurchase(ctxOf(w), { ...base, input: { a: 2 } }), 'request_conflict');
  });

  it('P7 arena.pay.concurrency: ten concurrent deliveries of one purchase and txn produce exactly one effect', async () => {
    const w = await world('p7');
    const quote = await quoteOf({ w, requestId: 'r-p7', count: 2 });
    const transfer = transferFor(w, quote);
    const counter = { runs: 0 };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        buy({
          w,
          requestId: 'r-p7',
          count: 2,
          txn: transfer.id,
          ledger: ledgerReturning(transfer),
          counter,
        }),
      ),
    );
    expect(counter.runs).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(await tasksIn(w.session)).toBe(2);
    expect(
      await f.count(
        `SELECT count(*) AS n FROM purchases WHERE workspace_id = $1 AND state = 'delivered'`,
        [w.ws.id],
      ),
    ).toBe(1);
  });

  it('P7b arena.pay.concurrent_txns: two different valid txns for ONE purchase deliver once; the loser replays the stored response and its txn stays unclaimed', async () => {
    const w = await world('p7b');
    const quote = await quoteOf({ w, requestId: 'r-p7b', count: 1 });
    const t1 = transferFor(w, quote);
    const t2 = transferFor(w, quote);
    const ledger = ledgerReturning(t1, t2);
    const counter = { runs: 0 };
    const [a, b] = await Promise.all([
      buy({ w, requestId: 'r-p7b', txn: t1.id, ledger, counter }),
      buy({ w, requestId: 'r-p7b', txn: t2.id, ledger, counter }),
    ]);
    expect(counter.runs).toBe(1);
    expect(a).toEqual(b); // never an idempotency_conflict: the buyer gets the one stored DELIVERED response
    expect(await tasksIn(w.session)).toBe(1);
    const claimed = await f.owner<{ txn_id: string }>(
      `SELECT txn_id FROM purchases WHERE txn_id IN ($1, $2)`,
      [t1.id, t2.id],
    );
    expect(claimed).toHaveLength(1); // only one txn is ever claimed; the other stays free
    expect([t1.id, t2.id]).toContain(claimed[0]?.txn_id);
  });

  it('P7c arena.pay.two_buyers_one_txn: one txn presented for two different purchases at once delivers one and refuses the other', async () => {
    const w = await world('p7c');
    const other = await buyerIn(w.ws, 'second');
    await f.join(w.session, other);
    const otherSeat = await seatOf(other);
    const qa = await quoteOf({ w, requestId: 'r-p7c-a', count: 1 });
    const qb = await quoteOf({ w, requestId: 'r-p7c-b', count: 1, actor: other });
    const shared = `txn_${tag()}`;
    // A ledger that (wrongly) shows the SAME txn as paying each buyer's purchase: only the UNIQUE claim stops it.
    const forA = transferFor(w, qa, { id: shared });
    const forB = transferFor(w, qb, { id: shared }, otherSeat);
    const deps = (): ArenaDeps => ({
      pool: f.pool,
      sharednetBaseUrl: BASE,
      ledgerFor: (room) =>
        room.actorId === other.id ? ledgerReturning(forB) : ledgerReturning(forA),
    });
    const attempt = (actor: Actor, requestId: string) =>
      purchase(
        deps(),
        ctxOf(w, actor),
        'create_tasks',
        {
          requestId,
          paymentTxnId: shared,
          target: { sessionId: w.session.id, boardId: w.session.boardId },
          input: { tasks: [{ title: 'task 0' }] },
          amount: 1,
        },
        tasksEffect(1, w.session.boardId),
      ).then(
        (value) => ({ ok: value }) as const,
        (error: unknown) => ({ error: error as ChorusError }) as const,
      );
    const results = await Promise.all([attempt(w.buyer, 'r-p7c-a'), attempt(other, 'r-p7c-b')]);
    expect(results.filter((r) => 'ok' in r)).toHaveLength(1);
    const refused = results.find((r) => 'error' in r);
    expect(refused && 'error' in refused ? refused.error.code : undefined).toBe(
      'payment_already_used',
    );
    expect(await tasksIn(w.session)).toBe(1);
    expect(await f.count(`SELECT count(*) AS n FROM purchases WHERE txn_id = $1`, [shared])).toBe(
      1,
    );
  });

  it('P8 arena.pay.crash_window: a failure AFTER the claiming UPDATE rolls back the claim, the effect and the events; a retry delivers once', async () => {
    const w = await world('p8');
    const quote = await quoteOf({ w, requestId: 'r-p8', count: 2 });
    const transfer = transferFor(w, quote);
    const eventsBefore = await f.count(
      `SELECT count(*) AS n FROM domain_events WHERE session_id = $1`,
      [w.session.id],
    );
    // The effect succeeds, and returns an event journaled in the WRONG room: runCommand refuses it while
    // journaling, which happens after the effect AND after the single UPDATE that claims the txn.
    const crashing: PurchaseEffect = async (tx) => {
      const done = await tasksEffect(2, w.session.boardId)(tx);
      const first = done.events[0];
      if (first === undefined) throw new Error('the effect journals events');
      return {
        result: done.result,
        events: [...done.events, { ...first, roomId: randomUUID() as Uuid, aggregateVersion: 2 }],
      };
    };
    const error = await buy({
      w,
      requestId: 'r-p8',
      count: 2,
      txn: transfer.id,
      ledger: ledgerReturning(transfer),
      effect: crashing,
    }).then(
      () => undefined,
      (e: unknown) => e as ChorusError,
    );
    expect(error?.code).toBe('internal_error');
    expect(error?.message).toContain("aggregate's own room");
    // Everything the transaction did is gone: the claim (the UPDATE that already ran), the tasks, the events.
    expect(await purchaseRow(quote['purchase_id'] as string)).toEqual({
      state: 'quoted',
      txn_id: null,
    });
    expect(
      await f.count(`SELECT count(*) AS n FROM purchases WHERE txn_id = $1`, [transfer.id]),
    ).toBe(0);
    expect(await tasksIn(w.session)).toBe(0);
    expect(
      await f.count(`SELECT count(*) AS n FROM domain_events WHERE session_id = $1`, [
        w.session.id,
      ]),
    ).toBe(eventsBefore);
    // A retry with the same txn delivers exactly once.
    const counter = { runs: 0 };
    const done = await buy({
      w,
      requestId: 'r-p8',
      count: 2,
      txn: transfer.id,
      ledger: ledgerReturning(transfer),
      counter,
    });
    expect(done.state).toBe('DELIVERED');
    expect(counter.runs).toBe(1);
    expect(await tasksIn(w.session)).toBe(2);
  });

  it('P9 arena.pay.ledger_outage: an outage changes nothing; paging stops at 5 pages or the age boundary', async () => {
    const w = await world('p9');
    const quote = await quoteOf({ w, requestId: 'r-p9', count: 1 });
    const missing = `txn_${tag()}`;
    const outage = createFakeLedgerClient([], { pageFailures: new Map([[1, 'http_status']]) });
    await expectCode(
      buy({ w, requestId: 'r-p9', txn: missing, ledger: outage }),
      'temporarily_unavailable',
      {
        cause: 'http_status',
      },
    );
    expect((await purchaseRow(quote['purchase_id'] as string))?.state).toBe('quoted');
    // 600 recent unrelated transfers: scanning stops after 5 pages (500 items) without finding it.
    const now = Date.now();
    const crowd = Array.from({ length: 600 }, (_, i) =>
      sampleTransfer({
        id: `txn_crowd${String(i).padStart(4, '0')}`,
        created_at: new Date(now - i).toISOString(),
      }),
    );
    const target = transferFor(w, quote, { created_at: new Date(now - 700).toISOString() });
    const deep = await buy({
      w,
      requestId: 'r-p9',
      txn: target.id,
      ledger: ledgerReturning(...crowd, target),
    }).then(
      () => undefined,
      (e: unknown) => e as ChorusError,
    );
    expect(deep?.code).toBe('payment_not_found');
    expect(deep?.retryable).toBe(true);
    expect(deep?.details).toMatchObject({ retry_after_seconds: 5, pages_scanned: 5 });
    // Older than the quote minus the slack: the scan stops at the age boundary after one page.
    const old = [
      sampleTransfer({
        id: `txn_old${tag()}`,
        created_at: new Date(now - 10 * 60_000).toISOString(),
      }),
    ];
    const shallow = await buy({
      w,
      requestId: 'r-p9',
      txn: missing,
      ledger: ledgerReturning(...old),
    }).then(
      () => undefined,
      (e: unknown) => e as ChorusError,
    );
    expect(shallow?.code).toBe('payment_not_found');
    expect(shallow?.details).toMatchObject({ pages_scanned: 1 });
    expect(await tasksIn(w.session)).toBe(0);
  });

  it('P13 arena.seat_binding: an instance without a proven seat cannot buy (reenroll_required)', async () => {
    const w = await world('p13');
    const legacy = await f.actor(w.ws, `legacy-${tag()}`); // sharednet_member_id stays NULL
    await f.join(w.session, legacy);
    await expectCode(buy({ w, requestId: 'r-p13', actor: legacy }), 'action_forbidden', {
      reason: 'reenroll_required',
    });
    expect(
      await f.count(`SELECT count(*) AS n FROM purchases WHERE actor_id = $1`, [legacy.id]),
    ).toBe(0);
    // No instance at all (a human/service token) cannot buy either.
    const noInstance = { ...ctxOf(w), instanceId: null };
    await expectCode(
      purchase(
        depsWith(forbiddenLedger),
        noInstance,
        'create_tasks',
        {
          requestId: 'r-p13-b',
          target: { sessionId: w.session.id, boardId: w.session.boardId },
          input: {},
          amount: 1,
        },
        tasksEffect(1, w.session.boardId),
      ),
      'action_forbidden',
      { reason: 'reenroll_required' },
    );
  });

  it('P14 arena.no_network_in_tx: no connection is inside a transaction while the ledger is queried', async () => {
    const w = await world('p14');
    const tagged = new pg.Pool({
      connectionString: f.db.appUrl,
      max: 6,
      application_name: 'chorus-arena-p14',
    });
    tagged.on('error', () => undefined);
    try {
      const observed: number[] = [];
      const quote = await quoteOf({ w, requestId: 'r-p14', count: 1 });
      const transfer = transferFor(w, quote);
      const inner = ledgerReturning(transfer);
      const watching: LedgerClient = {
        listTransfers: async (args, signal) => {
          const [row] = await f.owner<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity
              WHERE application_name = 'chorus-arena-p14'
                AND state IN ('idle in transaction', 'active') AND pid <> pg_backend_pid()`,
          );
          observed.push(Number(row?.n));
          return inner.listTransfers(args, signal);
        },
      };
      await purchase(
        { pool: tagged, sharednetBaseUrl: BASE, ledgerFor: () => watching },
        { ...ctxOf(w), pool: tagged },
        'create_tasks',
        {
          requestId: 'r-p14',
          paymentTxnId: transfer.id,
          target: { sessionId: w.session.id, boardId: w.session.boardId },
          input: { tasks: [{ title: 'task 0' }] },
          amount: 1,
        },
        tasksEffect(1, w.session.boardId),
      );
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((count) => count === 0)).toBe(true);
    } finally {
      await tagged.end();
    }
  });

  it('arena.rls_and_guards: buyers see only their purchases; delivered rows and price columns are immutable', async () => {
    const w = await world('guards');
    const other = await buyerIn(w.ws, 'nosy');
    await f.join(w.session, other);
    const quote = await quoteOf({ w, requestId: 'r-guard', count: 1 });
    const transfer = transferFor(w, quote);
    await buy({ w, requestId: 'r-guard', txn: transfer.id, ledger: ledgerReturning(transfer) });
    const mine = await findPurchase(f.readCtx(w.buyer), 'create_tasks', 'r-guard');
    expect(mine?.state).toBe('delivered');
    expect(await findPurchase(f.readCtx(other), 'create_tasks', 'r-guard')).toBeUndefined();

    const id = quote['purchase_id'] as string;
    await expect(
      f.owner(`UPDATE purchases SET amount = 9 WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: 'CH010' });
    await expect(
      f.owner(`UPDATE purchases SET response = '{}'::jsonb WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: 'CH010' });
    await expect(f.owner(`DELETE FROM purchases WHERE id = $1`, [id])).rejects.toBeDefined();
    // A quoted purchase's identity and price are frozen too; only the delivery columns may change.
    const q2 = await quoteOf({ w, requestId: 'r-guard-2', count: 1 });
    await expect(
      f.owner(`UPDATE purchases SET amount = 2, memo = 'x' WHERE id = $1`, [q2['purchase_id']]),
    ).rejects.toMatchObject({ code: 'CH010' });
    // A verification failure must belong to a purchase of ITS OWN workspace (composite foreign key).
    const foreign = await world('guards-foreign');
    const foreignQuote = await quoteOf({ w: foreign, requestId: 'r-foreign', count: 1 });
    await expect(
      f.owner(
        `INSERT INTO payment_verification_failures (workspace_id, actor_id, purchase_id, txn_id, reason, observed)
         VALUES ($1, $2, $3, 'txn_CrossWs01', 'memo', '{}'::jsonb)`,
        [w.ws.id, w.buyer.id, foreignQuote['purchase_id']],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // The runtime role may update only the delivery columns.
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
        [w.ws.id, w.buyer.id],
      );
      await expect(
        client.query(`UPDATE purchases SET amount = 5 WHERE id = $1`, [q2['purchase_id']]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('arena.deliver_domain: delivering directly refuses a txn another purchase holds', async () => {
    const w = await world('domain');
    const q1 = (await quotePurchase(ctxOf(w), {
      service: 'create_tasks',
      request_id: 'd1',
      target: { session_id: w.session.id, board_id: w.session.boardId },
      input: { n: 1 },
      amount: 1,
      payee: { member_id: w.payee.memberId, principal_id: w.payee.principalId },
      requester_member_id: w.seat,
    })) satisfies Purchase;
    const q2 = await quotePurchase(ctxOf(w), {
      service: 'create_tasks',
      request_id: 'd2',
      target: { session_id: w.session.id, board_id: w.session.boardId },
      input: { n: 2 },
      amount: 1,
      payee: { member_id: w.payee.memberId, principal_id: w.payee.principalId },
      requester_member_id: w.seat,
    });
    const txn = `txn_${tag()}`;
    await deliverPurchase(ctxOf(w), {
      purchase: q1,
      txn_id: txn,
      effect: tasksEffect(1, w.session.boardId),
    });
    await expectCode(
      deliverPurchase(ctxOf(w), {
        purchase: q2,
        txn_id: txn,
        effect: tasksEffect(1, w.session.boardId),
      }),
      'payment_already_used',
    );
    expect((await purchaseRow(q2.id))?.state).toBe('quoted');
    expect(await tasksIn(w.session)).toBe(1);
  });

  it('arena.ledger_for: the sealed payee token is opened in memory and sent as the bearer; a non-member gets room_not_available', async () => {
    const key = randomBytes(32);
    const token = `sni_payee${tag()}${tag()}`;
    const ws = await f.workspace(`ledger-${tag()}`);
    const external = `rom_${tag()}Room`;
    await f.owner(`UPDATE rooms SET provider = 'sharednet', external_room_id = $2 WHERE id = $1`, [
      ws.roomId,
      external,
    ]);
    const sealed = sealSecret(key, token);
    await f.owner(
      `INSERT INTO sharednet_seats (workspace_id, room_id, member_id, principal_id, token_ciphertext, token_nonce, key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ws.id,
        ws.roomId,
        `i_Payee${tag()}`,
        `p_Payee${tag()}`,
        sealed.ciphertext,
        sealed.nonce,
        sealed.keyId,
      ],
    );
    const member = await f.actor(ws, `member-${tag()}`);
    const outsider = await f.actor(ws, `outsider-${tag()}`, { inRoom: false });
    const server = await startFakeLedgerServer([sampleTransfer({ id: 'txn_LedgerFor01' })]);
    try {
      const ledgerFor = createLedgerFor(f.pool, key, server.url);
      const room = (actor: Actor) => ({
        workspaceId: ws.id,
        actorId: actor.id,
        roomId: ws.roomId,
        externalRoomId: external,
      });
      const client = await ledgerFor(room(member));
      const page = await client.listTransfers({ limit: 10 }, new AbortController().signal);
      expect(page.items.map((t) => t.id)).toEqual(['txn_LedgerFor01']);
      expect(server.requests[0]?.auth).toBe(`Bearer ${token}`);
      // Not a live member of the room: no seat is returned at all.
      await expectCode(Promise.resolve(ledgerFor(room(outsider))), 'room_not_available');
      // A wrong key fails without ever putting the token in the error.
      const wrongKey = createLedgerFor(f.pool, randomBytes(32), server.url);
      const wrong = await Promise.resolve(wrongKey(room(member))).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(wrong).toBeInstanceOf(Error);
      expect(wrong?.message).not.toContain(token);
    } finally {
      await server.close();
    }
  });
});
