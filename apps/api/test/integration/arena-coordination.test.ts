import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject, SharedOSKernel, ToolResult } from '@aicoo/sharedos';
import {
  LedgerUnavailableError,
  type CreditTransfer,
  type LedgerClient,
  type TransferRequest,
} from '@chorus/sharednet-ledger';
import { createFakeLedgerClient, sampleTransfer } from '@chorus/sharednet-ledger/testing';
import {
  createFixture,
  type Actor,
  type Fixture,
  type SessionSeed,
} from '../../../../packages/domain/test/helpers/fixture.ts';
import { coordinationModeOf, findRefund, isChorusError } from '@chorus/domain';
import { RateLimiter } from '../../src/rate-limit.ts';
import { buildAccessContext } from '../../src/sharedos/access-context.ts';
import { createChorusKernel } from '../../src/sharedos/kernel.ts';
import { runInRequestScope, type ChorusRequestScope } from '../../src/sharedos/request-scope.ts';

const BASE = 'https://www.sharednet.ai';
const noopLogger = { error: () => undefined };

describe('paid coordination modes (real PostgreSQL as chorus_app, fake ledger)', () => {
  let f: Fixture;
  const transfers: CreditTransfer[] = [];
  let ledgerCalls = 0;
  /** Runs once, DURING the next payment verification (outside any transaction), to interleave a change. */
  let duringVerification: (() => Promise<unknown>) | undefined;
  /** Refund transfers SharedNet accepted: one per Idempotency-Key, as SharedNet guarantees. */
  const refunds: (TransferRequest & { id: string })[] = [];
  /** How many refund attempts to fail (as a network error) before accepting. */
  let failRefunds = 0;
  const ledger: LedgerClient = {
    listTransfers: async (args, signal) => {
      ledgerCalls++;
      const hook = duringVerification;
      duringVerification = undefined;
      if (hook !== undefined) await hook();
      return createFakeLedgerClient(transfers).listTransfers(args, signal);
    },
    transfer: (request) => {
      if (failRefunds > 0) {
        failRefunds--;
        return Promise.reject(new LedgerUnavailableError('network'));
      }
      const known = refunds.find((r) => r.idempotencyKey === request.idempotencyKey);
      if (known !== undefined) return Promise.resolve({ id: known.id });
      const sent = { ...request, id: `txn_Refund${tag()}` };
      refunds.push(sent);
      return Promise.resolve({ id: sent.id });
    },
  };
  const kernels = new Map<'enabled' | 'disabled', SharedOSKernel>();
  const kernelFor = (billing: 'enabled' | 'disabled'): SharedOSKernel => {
    const existing = kernels.get(billing);
    if (existing !== undefined) return existing;
    const { kernel } = createChorusKernel({
      pool: f.pool,
      leaseDurationSeconds: 900,
      gitCommit: 'test',
      billing,
      arena: { pool: f.pool, sharednetBaseUrl: BASE, ledgerFor: () => ledger },
      limits: {
        paid: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
        pulse: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
      },
      logger: noopLogger,
    });
    kernels.set(billing, kernel);
    return kernel;
  };

  beforeAll(async () => {
    f = await createFixture({ poolMax: 16 });
  });
  afterAll(async () => {
    await f.close();
  });

  let n = 0;
  const tag = () => `${String(++n).padStart(4, '0')}${randomBytes(3).toString('hex')}`;

  interface World {
    external: string;
    payee: { memberId: string; principalId: string };
    admin: Actor;
    seat: string;
    session: SessionSeed;
  }
  const CHECKPOINT = 500;
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
    // The watcher checkpoint an enable jumps the engine cursor to.
    await f.owner(
      'INSERT INTO sharednet_cursors (workspace_id, room_id, last_sequence) VALUES ($1, $2, $3)',
      [ws.id, ws.roomId, CHECKPOINT],
    );
    const admin = await seated(ws, 'admin');
    return { external, payee, admin, seat: await seatOf(admin), session: await f.session(admin) };
  }
  async function seated(ws: Actor['ws'], label: string): Promise<Actor> {
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

  const scopeOf = (a: Actor): ChorusRequestScope => ({
    workspaceId: a.ws.id,
    actorId: a.id,
    instanceId: a.instanceId,
    roomId: a.ws.roomId,
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const invoke = (
    billing: 'enabled' | 'disabled',
    a: Actor,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const traceId = randomUUID();
    const scope = scopeOf(a);
    const context = buildAccessContext(scope, traceId, new Date());
    return runInRequestScope(scope, () =>
      kernelFor(billing).invokeTool(context, {
        id: randomUUID(),
        tool,
        arguments: args as JsonObject,
        traceId,
        requestedAt: context.now,
      }),
    );
  };
  const failed = (r: ToolResult) => {
    expect(r.status, JSON.stringify(r)).toBe('failed');
    return (r as { error: { code: string; details?: Record<string, unknown> } }).error;
  };
  const okOut = (r: ToolResult): Record<string, unknown> => {
    expect(r.status, JSON.stringify(r)).toBe('succeeded');
    return (r as { output: Record<string, unknown> }).output;
  };
  const pay = (w: World, quote: Record<string, unknown>, over: Partial<CreditTransfer> = {}) => {
    const transfer = sampleTransfer({
      id: `txn_${tag()}`,
      to_principal_id: w.payee.principalId,
      addressed_to: w.payee.memberId,
      by_instance_id: w.seat,
      room_id: w.external,
      amount: quote['amount'] as number,
      memo: quote['memo'] as string,
      created_at: new Date().toISOString(),
      ...over,
    });
    transfers.push(transfer);
    return transfer;
  };

  const sessionState = async (w: World) =>
    (
      await f.owner<{ mode: string; version: number }>(
        'SELECT coordination_mode AS mode, version FROM sessions WHERE id = $1',
        [w.session.id],
      )
    )[0] ?? { mode: '', version: 0 };
  const engineCursor = async (w: World) =>
    Number(
      (
        await f.owner<{ cursor: string }>(
          'SELECT cursor FROM conversation_engine_state WHERE session_id = $1',
          [w.session.id],
        )
      )[0]?.cursor ?? -1,
    );
  const purchases = (w: World) =>
    f.count('SELECT count(*) AS n FROM purchases WHERE session_id = $1', [w.session.id]);
  const modeArgs = async (w: World, mode: string, requestId: string) => ({
    request_id: requestId,
    session_id: w.session.id,
    mode,
    expected_version: (await sessionState(w)).version,
  });
  /** Quote, pay the quote exactly, deliver: returns the quote and the delivery. */
  const buy = async (w: World, mode: string, requestId: string) => {
    const args = await modeArgs(w, mode, requestId);
    const quote =
      failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', args)).details ?? {};
    const transfer = pay(w, quote);
    const delivered = okOut(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        ...args,
        payment_txn_id: transfer.id,
      }),
    );
    return { args, quote, transfer, delivered };
  };

  it('quotes by the current mode: off → observe 2, off → assist 3, observe → assist 1 (the difference)', async () => {
    const w = await world('quote');
    for (const [mode, amount] of [
      ['observe', 2],
      ['assist', 3],
    ] as const) {
      const quote = failed(
        await invoke(
          'enabled',
          w.admin,
          'chorus.set_coordination_mode',
          await modeArgs(w, mode, `q-off-${mode}`),
        ),
      );
      expect(quote.code).toBe('payment_required');
      expect(quote.details).toMatchObject({
        state: 'PAYMENT_REQUIRED',
        service: 'set_coordination_mode',
        amount,
        currency: 'sharednet_credits',
        pay_from_seat: w.seat,
        room_id: w.external,
      });
      expect(quote.details?.['memo']).toMatch(/^chorus:v1:set_coordination_mode:/);
    }
    await buy(w, 'observe', 'q-buy-observe');
    const upgrade = failed(
      await invoke(
        'enabled',
        w.admin,
        'chorus.set_coordination_mode',
        await modeArgs(w, 'assist', 'q-upgrade'),
      ),
    );
    expect(upgrade.details).toMatchObject({ amount: 1, service: 'set_coordination_mode' });
  });

  it('delivery after payment sets the mode and jumps the cursor; a replay returns the same delivery without charging', async () => {
    const w = await world('deliver');
    expect(await sessionState(w)).toMatchObject({ mode: 'off' });
    const { args, transfer, delivered } = await buy(w, 'assist', 'd-assist');
    expect(delivered).toMatchObject({
      state: 'DELIVERED',
      service: 'set_coordination_mode',
      request_id: 'd-assist',
      amount: 3,
      txn_id: transfer.id,
      result: { session_id: w.session.id, changed: ['coordination_mode'] },
    });
    expect(await sessionState(w)).toMatchObject({
      mode: 'assist',
      version: args.expected_version + 1,
    });
    expect(await engineCursor(w)).toBe(CHECKPOINT);

    const callsBefore = ledgerCalls;
    const purchasesBefore = await purchases(w);
    const replay = okOut(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        ...args,
        payment_txn_id: transfer.id,
      }),
    );
    const { audit_trace_id: _a, ...first } = delivered;
    const { audit_trace_id: _b, ...again } = replay;
    expect(again).toEqual(first);
    expect(ledgerCalls).toBe(callsBefore);
    expect(await purchases(w)).toBe(purchasesBefore);
    expect(await sessionState(w)).toMatchObject({
      mode: 'assist',
      version: args.expected_version + 1,
    });
  });

  it('a payment with the wrong amount or memo is not accepted, and nothing changes', async () => {
    const w = await world('wrong');
    const args = await modeArgs(w, 'observe', 'w-observe');
    const quote =
      failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', args)).details ?? {};
    for (const [over, reason] of [
      [{ amount: 1 }, 'amount'],
      [{ memo: 'chorus:v1:set_coordination_mode:someone-else' }, 'memo'],
    ] as const) {
      const transfer = pay(w, quote, over);
      const refused = failed(
        await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
          ...args,
          payment_txn_id: transfer.id,
        }),
      );
      expect(refused).toMatchObject({ code: 'payment_not_verified', details: { reason } });
    }
    expect(await sessionState(w)).toMatchObject({ mode: 'off', version: args.expected_version });
    expect(await engineCursor(w)).toBe(-1);
  });

  it('the same mode, lowering, and off are free and never quote', async () => {
    const w = await world('free');
    await buy(w, 'assist', 'f-assist');
    const purchasesBefore = await purchases(w);
    for (const [mode, requestId] of [
      ['assist', 'f-same'],
      ['observe', 'f-lower'],
      ['off', 'f-off'],
      ['off', 'f-off-again'],
    ] as const) {
      const done = okOut(
        await invoke(
          'enabled',
          w.admin,
          'chorus.set_coordination_mode',
          await modeArgs(w, mode, requestId),
        ),
      );
      expect(done).toMatchObject({ session_id: w.session.id, changed: ['coordination_mode'] });
      expect(done['state']).toBeUndefined();
      expect((await sessionState(w)).mode).toBe(mode);
    }
    expect(await purchases(w)).toBe(purchasesBefore);
    // A free change keyed by its request_id replays instead of applying twice.
    const version = (await sessionState(w)).version;
    const args = await modeArgs(w, 'off', 'f-replay');
    okOut(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', args));
    okOut(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', args));
    expect((await sessionState(w)).version).toBe(version + 1);
  });

  it('set_session_policy refuses observe/assist with billing on (use the paid tool) and accepts them with billing off', async () => {
    const w = await world('policy');
    for (const mode of ['observe', 'assist']) {
      const refused = failed(
        await invoke('enabled', w.admin, 'chorus.set_session_policy', {
          idempotency_key: randomUUID(),
          session_id: w.session.id,
          expected_version: (await sessionState(w)).version,
          coordination_mode: mode,
        }),
      );
      expect(refused).toMatchObject({
        code: 'invalid_request',
        details: {
          field: 'coordination_mode',
          reason: 'paid_mode',
          use_tool: 'chorus.set_coordination_mode',
        },
      });
    }
    expect((await sessionState(w)).mode).toBe('off');
    okOut(
      await invoke('enabled', w.admin, 'chorus.set_session_policy', {
        idempotency_key: randomUUID(),
        session_id: w.session.id,
        expected_version: (await sessionState(w)).version,
        coordination_mode: 'off',
      }),
    );
    for (const mode of ['observe', 'assist']) {
      okOut(
        await invoke('disabled', w.admin, 'chorus.set_session_policy', {
          idempotency_key: randomUUID(),
          session_id: w.session.id,
          expected_version: (await sessionState(w)).version,
          coordination_mode: mode,
        }),
      );
      expect((await sessionState(w)).mode).toBe(mode);
    }
    // With billing off the mode tool stays free, exactly as before: an idempotency_key, no quote.
    okOut(
      await invoke('disabled', w.admin, 'chorus.set_coordination_mode', {
        idempotency_key: randomUUID(),
        session_id: w.session.id,
        expected_version: (await sessionState(w)).version,
        mode: 'observe',
      }),
    );
    expect(await purchases(w)).toBe(0);
  });

  it('a non-administrator is denied before any quote', async () => {
    const w = await world('nonadmin');
    const member = await seated(w.admin.ws, 'member');
    await f.join(w.session, member, ['participant', 'manager']);
    const result = await invoke(
      'enabled',
      member,
      'chorus.set_coordination_mode',
      await modeArgs(w, 'assist', 'n-assist'),
    );
    // SharedOS refuses it at the grant (administer) before the tool runs.
    expect(result.status).toBe('denied');
    expect(await purchases(w)).toBe(0);
    expect((await sessionState(w)).mode).toBe('off');
    // The tool's own pricing read refuses a non-administrator too, and a non-member learns nothing.
    const refusal = async (read: ReturnType<Fixture['readCtx']>) => {
      try {
        await coordinationModeOf(read, w.session.id);
        return 'allowed';
      } catch (error) {
        return isChorusError(error) ? error.code : 'thrown';
      }
    };
    expect(await refusal(f.readCtx(member))).toBe('action_forbidden');
    const stranger = await seated(w.admin.ws, 'stranger');
    expect(await refusal(f.readCtx(stranger))).toBe('not_found');
  });

  it('the quote-vs-delivery race: a changed mode is refused (never under-delivered); an unrelated change needs only a retry at the new version', async () => {
    // (1) Quoted observe → assist at 1, then an admin turns it off (free). The same 1 credit would now
    // buy off → assist (3): refused as mode_changed, and the mode stays off.
    const w = await world('race');
    await buy(w, 'observe', 'r-observe');
    const upgrade = await modeArgs(w, 'assist', 'r-upgrade');
    const quote =
      failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', upgrade)).details ??
      {};
    expect(quote['amount']).toBe(1);
    okOut(
      await invoke(
        'enabled',
        w.admin,
        'chorus.set_coordination_mode',
        await modeArgs(w, 'off', 'r-off'),
      ),
    );
    const transfer = pay(w, quote);
    const refused = failed(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        ...upgrade,
        expected_version: (await sessionState(w)).version,
        payment_txn_id: transfer.id,
      }),
    );
    expect(refused).toMatchObject({
      code: 'invalid_transition',
      details: { reason: 'mode_changed', current_mode: 'off', quoted_amount: 1, current_amount: 3 },
    });
    expect((await sessionState(w)).mode).toBe('off');
    const stored = await f.owner<{ state: string; txn_id: string | null }>(
      `SELECT state, txn_id FROM purchases WHERE session_id = $1 AND request_id = 'r-upgrade'`,
      [w.session.id],
    );
    expect(stored).toEqual([{ state: 'quoted', txn_id: null }]);
    // At the quoted mode again, the same payment delivers exactly what it paid for.
    await f.owner(`UPDATE sessions SET coordination_mode = 'observe' WHERE id = $1`, [
      w.session.id,
    ]);
    const delivered = okOut(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        ...upgrade,
        expected_version: (await sessionState(w)).version,
        payment_txn_id: transfer.id,
      }),
    );
    expect(delivered).toMatchObject({ state: 'DELIVERED', amount: 1 });
    expect((await sessionState(w)).mode).toBe('assist');

    // (2) A cheaper mode now (quoted off → assist at 3, then observe is set without a version bump): the
    // price differs, so it is refused too rather than silently delivering.
    const w2 = await world('race2');
    const args2 = await modeArgs(w2, 'assist', 'r2-assist');
    const quote2 =
      failed(await invoke('enabled', w2.admin, 'chorus.set_coordination_mode', args2)).details ??
      {};
    await f.owner(`UPDATE sessions SET coordination_mode = 'observe' WHERE id = $1`, [
      w2.session.id,
    ]);
    const refused2 = failed(
      await invoke('enabled', w2.admin, 'chorus.set_coordination_mode', {
        ...args2,
        payment_txn_id: pay(w2, quote2).id,
      }),
    );
    expect(refused2).toMatchObject({
      code: 'invalid_transition',
      details: { reason: 'mode_changed', quoted_amount: 3, current_amount: 1 },
    });
    expect((await sessionState(w2)).mode).toBe('observe');

    // (3) An unrelated policy change after paying: the old version conflicts, and a retry at the new
    // version with the same payment delivers.
    const w3 = await world('race3');
    const args3 = await modeArgs(w3, 'observe', 'r3-observe');
    const quote3 =
      failed(await invoke('enabled', w3.admin, 'chorus.set_coordination_mode', args3)).details ??
      {};
    okOut(
      await invoke('enabled', w3.admin, 'chorus.set_session_policy', {
        idempotency_key: randomUUID(),
        session_id: w3.session.id,
        expected_version: args3.expected_version,
        name: 'renamed',
      }),
    );
    const txn3 = pay(w3, quote3).id;
    expect(
      failed(
        await invoke('enabled', w3.admin, 'chorus.set_coordination_mode', {
          ...args3,
          payment_txn_id: txn3,
        }),
      ).code,
    ).toBe('version_conflict');
    expect((await sessionState(w3)).mode).toBe('off');
    const retried = okOut(
      await invoke('enabled', w3.admin, 'chorus.set_coordination_mode', {
        ...args3,
        expected_version: (await sessionState(w3)).version,
        payment_txn_id: txn3,
      }),
    );
    expect(retried).toMatchObject({ state: 'DELIVERED', amount: 2, txn_id: txn3 });
    expect((await sessionState(w3)).mode).toBe('observe');
    expect(await engineCursor(w3)).toBe(CHECKPOINT);
  });

  it('a stale expected_version is refused before anything is quoted', async () => {
    const w = await world('stale');
    const args = await modeArgs(w, 'assist', 's-assist');
    const stale = failed(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        ...args,
        expected_version: args.expected_version - 1,
      }),
    );
    expect(stale.code).toBe('version_conflict');
    expect(await purchases(w)).toBe(0);
  });
  it('a stale unpaid quote is refused BEFORE payment is requested; a new request_id gets the current price', async () => {
    const w = await world('stale-quote');
    const r1 = await modeArgs(w, 'observe', 'sq-r1');
    expect(
      failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', r1)).details,
    ).toMatchObject({ amount: 2 });
    await buy(w, 'assist', 'sq-r2');
    // observe is now a free downgrade: r1 must not ask for its old 2 credits.
    const callsBefore = ledgerCalls;
    const stale = failed(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        ...r1,
        expected_version: (await sessionState(w)).version,
      }),
    );
    expect(stale).toMatchObject({
      code: 'invalid_transition',
      details: {
        reason: 'mode_changed',
        current_mode: 'assist',
        quoted_amount: 2,
        current_amount: 0,
      },
    });
    expect(ledgerCalls).toBe(callsBefore);
    expect((await sessionState(w)).mode).toBe('assist');
    const free = okOut(
      await invoke(
        'enabled',
        w.admin,
        'chorus.set_coordination_mode',
        await modeArgs(w, 'observe', 'sq-r3'),
      ),
    );
    expect(free).toMatchObject({ changed: ['coordination_mode'] });
    expect((await sessionState(w)).mode).toBe('observe');
  });

  it('the in-transaction guard: a mode change DURING payment verification is refused at delivery', async () => {
    const w = await world('guard');
    const args = await modeArgs(w, 'assist', 'g-assist');
    const quote =
      failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', args)).details ?? {};
    const transfer = pay(w, quote);
    // Verification runs outside any transaction; the mode moves to observe while it does (no version bump).
    duringVerification = () =>
      f.owner(`UPDATE sessions SET coordination_mode = 'observe' WHERE id = $1`, [w.session.id]);
    const refused = failed(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        ...args,
        payment_txn_id: transfer.id,
      }),
    );
    expect(refused).toMatchObject({
      code: 'invalid_transition',
      details: { reason: 'mode_changed', quoted_amount: 3, current_amount: 1 },
    });
    expect(duringVerification).toBeUndefined();
    expect((await sessionState(w)).mode).toBe('observe');
    const stored = await f.owner<{ state: string; txn_id: string | null }>(
      `SELECT state, txn_id FROM purchases WHERE session_id = $1 AND request_id = 'g-assist'`,
      [w.session.id],
    );
    expect(stored).toEqual([{ state: 'quoted', txn_id: null }]);
  });

  it('the pre-billing call shape still works: idempotency_key in place of request_id', async () => {
    const w = await world('compat');
    const key = randomUUID();
    const quote = failed(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        idempotency_key: key,
        session_id: w.session.id,
        mode: 'observe',
        expected_version: (await sessionState(w)).version,
      }),
    );
    expect(quote).toMatchObject({
      code: 'payment_required',
      details: { amount: 2, request_id: key },
    });
    await buy(w, 'assist', 'c-assist');
    const lower = {
      idempotency_key: randomUUID(),
      session_id: w.session.id,
      mode: 'off',
      expected_version: (await sessionState(w)).version,
    };
    okOut(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', lower));
    const version = (await sessionState(w)).version;
    okOut(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', lower));
    expect(await sessionState(w)).toMatchObject({ mode: 'off', version });
    const missing = failed(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        session_id: w.session.id,
        mode: 'off',
        expected_version: version,
      }),
    );
    expect(missing).toMatchObject({ code: 'invalid_request', details: { field: 'request_id' } });
  });

  it('a request_id reused with different arguments is request_conflict on the free path too', async () => {
    const w = await world('conflict');
    await buy(w, 'assist', 'k-assist');
    okOut(
      await invoke(
        'enabled',
        w.admin,
        'chorus.set_coordination_mode',
        await modeArgs(w, 'observe', 'k-free'),
      ),
    );
    const reused = failed(
      await invoke(
        'enabled',
        w.admin,
        'chorus.set_coordination_mode',
        await modeArgs(w, 'off', 'k-free'),
      ),
    );
    expect(reused.code).toBe('request_conflict');
    expect((await sessionState(w)).mode).toBe('observe');
  });
  it('a request_id reused for a different mode is request_conflict, never a misleading mode_changed', async () => {
    const w = await world('reuse');
    const observe = await modeArgs(w, 'observe', 'u-r1');
    expect(
      failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', observe)).code,
    ).toBe('payment_required');
    const reused = failed(
      await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
        ...observe,
        mode: 'assist',
      }),
    );
    expect(reused.code).toBe('request_conflict');
    // The same request with a stale version (its price unchanged) is a version_conflict, before any payment.
    okOut(
      await invoke('enabled', w.admin, 'chorus.set_session_policy', {
        idempotency_key: randomUUID(),
        session_id: w.session.id,
        expected_version: observe.expected_version,
        name: 'renamed',
      }),
    );
    const callsBefore = ledgerCalls;
    expect(
      failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', observe)).code,
    ).toBe('version_conflict');
    expect(ledgerCalls).toBe(callsBefore);
  });

  it('an idempotency_key that cannot serve as a request_id is refused clearly, before any quote', async () => {
    const w = await world('badkey');
    for (const key of ['has space', 'k'.repeat(101)]) {
      const refused = failed(
        await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
          idempotency_key: key,
          session_id: w.session.id,
          mode: 'assist',
          expected_version: (await sessionState(w)).version,
        }),
      );
      expect(refused).toMatchObject({
        code: 'invalid_request',
        details: { field: 'idempotency_key' },
      });
    }
    expect(await purchases(w)).toBe(0);
  });

  it('the paid mode change is audited: its session.policy_changed event carries the purchase', async () => {
    const w = await world('audit');
    const { delivered, transfer } = await buy(w, 'observe', 'a-observe');
    const events = await f.owner<{
      payload: {
        changed?: string[];
        purchase?: { purchase_id: string; txn_id: string; amount: number };
      };
    }>(
      `SELECT payload FROM domain_events
        WHERE aggregate_id = $1 AND event_type = 'session.policy_changed'
        ORDER BY aggregate_version DESC LIMIT 1`,
      [w.session.id],
    );
    expect(events[0]?.payload).toMatchObject({
      changed: ['coordination_mode'],
      purchase: {
        purchase_id: delivered['purchase_id'],
        service: 'set_coordination_mode',
        amount: 2,
        txn_id: transfer.id,
      },
    });
  });
  it('a request_id spent on a free change is request_conflict when reused for a raise (no quote)', async () => {
    const w = await world('spent');
    await buy(w, 'assist', 'sp-buy');
    okOut(
      await invoke(
        'enabled',
        w.admin,
        'chorus.set_coordination_mode',
        await modeArgs(w, 'off', 'sp-r'),
      ),
    );
    const before = await purchases(w);
    const reused = failed(
      await invoke(
        'enabled',
        w.admin,
        'chorus.set_coordination_mode',
        await modeArgs(w, 'observe', 'sp-r'),
      ),
    );
    expect(reused.code).toBe('request_conflict');
    expect(await purchases(w)).toBe(before);
    expect((await sessionState(w)).mode).toBe('off');
  });

  describe('the refund/void path', () => {
    /** Quotes observe → assist, turns the mode off (free), pays: the delivery is refused as mode_changed. */
    const stranded = async (label: string) => {
      const w = await world(label);
      await buy(w, 'observe', `${label}-observe`);
      const args = await modeArgs(w, 'assist', `${label}-assist`);
      const quote =
        failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', args)).details ??
        {};
      okOut(
        await invoke(
          'enabled',
          w.admin,
          'chorus.set_coordination_mode',
          await modeArgs(w, 'off', `${label}-off`),
        ),
      );
      const transfer = pay(w, quote);
      const refused = failed(
        await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
          ...args,
          expected_version: (await sessionState(w)).version,
          payment_txn_id: transfer.id,
        }),
      );
      return { w, args, quote, transfer, refused };
    };
    const voidArgs = (requestId: string, txn: string) => ({
      service: 'set_coordination_mode',
      request_id: requestId,
      payment_txn_id: txn,
    });
    const purchaseState = async (w: World, requestId: string) =>
      (
        await f.owner<{ state: string; txn_id: string | null }>(
          'SELECT state, txn_id FROM purchases WHERE session_id = $1 AND request_id = $2',
          [w.session.id, requestId],
        )
      )[0];

    it('a paid delivery refused by the race says the payment is unspent and how to get it back', async () => {
      const { transfer, refused } = await stranded('hint');
      expect(refused).toMatchObject({
        code: 'invalid_transition',
        details: {
          reason: 'mode_changed',
          refund_available: {
            tool: 'chorus.void_purchase',
            arguments: voidArgs('hint-assist', transfer.id),
          },
        },
      });
    });

    it('voiding refunds the seat that paid, once, and the purchase can never be delivered afterwards', async () => {
      const { w, args, quote, transfer } = await stranded('void');
      const voided = okOut(
        await invoke(
          'enabled',
          w.admin,
          'chorus.void_purchase',
          voidArgs('void-assist', transfer.id),
        ),
      );
      expect(voided).toMatchObject({
        state: 'VOIDED',
        service: 'set_coordination_mode',
        request_id: 'void-assist',
        amount: 1,
        txn_id: transfer.id,
        refund: { state: 'sent', amount: 1, to_member_id: w.seat },
      });
      const refund = voided['refund'] as { refund_txn_id: string };
      const sent = refunds.filter((r) => r.id === refund.refund_txn_id);
      expect(sent).toEqual([
        expect.objectContaining({
          to: w.seat,
          amount: 1,
          memo: `chorus:v1:refund:${String(quote['purchase_id'])}`,
          roomId: w.external,
        }),
      ]);
      expect(await purchaseState(w, 'void-assist')).toEqual({
        state: 'voided',
        txn_id: transfer.id,
      });

      // Voiding again returns the same refund and sends nothing new.
      const again = okOut(
        await invoke(
          'enabled',
          w.admin,
          'chorus.void_purchase',
          voidArgs('void-assist', transfer.id),
        ),
      );
      const { audit_trace_id: _first, ...stable } = voided;
      const { audit_trace_id: _again, ...repeated } = again;
      expect(repeated).toEqual(stable);
      expect(refunds.filter((r) => r.to === w.seat)).toHaveLength(1);

      // Even where the delivery would now succeed, a voided purchase is never delivered.
      await f.owner(`UPDATE sessions SET coordination_mode = 'observe' WHERE id = $1`, [
        w.session.id,
      ]);
      const late = failed(
        await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
          ...args,
          expected_version: (await sessionState(w)).version,
          payment_txn_id: transfer.id,
        }),
      );
      expect(late).toMatchObject({
        code: 'invalid_transition',
        details: { reason: 'purchase_voided' },
      });
      expect(late.details?.['refund_available']).toBeUndefined();
      expect((await sessionState(w)).mode).toBe('observe');

      // The refunded payment cannot buy anything else either.
      const other = await modeArgs(w, 'assist', 'void-other');
      failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', other));
      expect(
        failed(
          await invoke('enabled', w.admin, 'chorus.set_coordination_mode', {
            ...other,
            payment_txn_id: transfer.id,
          }),
        ).code,
      ).toMatch(/^payment_(already_used|not_verified)$/);
    });

    it('a refund SharedNet did not accept stays pending, and calling again sends it exactly once', async () => {
      const { w, transfer } = await stranded('pending');
      failRefunds = 1;
      const first = okOut(
        await invoke(
          'enabled',
          w.admin,
          'chorus.void_purchase',
          voidArgs('pending-assist', transfer.id),
        ),
      );
      expect(first).toMatchObject({
        state: 'VOIDED',
        refund: { state: 'pending', refund_txn_id: null, pending_cause: 'network' },
      });
      expect(refunds.filter((r) => r.to === w.seat)).toHaveLength(0);
      const second = okOut(
        await invoke(
          'enabled',
          w.admin,
          'chorus.void_purchase',
          voidArgs('pending-assist', transfer.id),
        ),
      );
      expect(second).toMatchObject({ refund: { state: 'sent', to_member_id: w.seat } });
      expect(refunds.filter((r) => r.to === w.seat)).toHaveLength(1);
    });

    it('voided purchases and sent refunds are immutable, and only the buyer sees a refund', async () => {
      const { w, transfer } = await stranded('void-guard');
      const voided = okOut(
        await invoke(
          'enabled',
          w.admin,
          'chorus.void_purchase',
          voidArgs('void-guard-assist', transfer.id),
        ),
      );
      const id = voided['purchase_id'] as string;
      await expect(
        f.owner(`UPDATE purchases SET state = 'quoted', txn_id = NULL WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: 'CH010' });
      await expect(
        f.owner(
          `UPDATE purchase_refunds SET refund_txn_id = 'txn_Other12345' WHERE purchase_id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({ code: 'CH010' });
      await expect(
        f.owner(`DELETE FROM purchase_refunds WHERE purchase_id = $1`, [id]),
      ).rejects.toBeDefined();
      // A voided purchase must hold the payment it voided.
      const unpaid = failed(
        await invoke(
          'enabled',
          w.admin,
          'chorus.set_coordination_mode',
          await modeArgs(w, 'assist', 'void-guard-unpaid'),
        ),
      ).details;
      await expect(
        f.owner(`UPDATE purchases SET state = 'voided' WHERE id = $1`, [unpaid?.['purchase_id']]),
      ).rejects.toMatchObject({ code: '23514' });
      const stranger = await seated(w.admin.ws, 'refund-nosy');
      expect(await findRefund(f.readCtx(w.admin), id)).toMatchObject({ purchase_id: id });
      expect(await findRefund(f.readCtx(stranger), id)).toBeUndefined();
    });

    it('refuses to void a delivered purchase, an unpaid one, and someone else’s request', async () => {
      const w = await world('void-refuse');
      const { transfer } = await buy(w, 'observe', 'vr-observe');
      expect(
        failed(
          await invoke(
            'enabled',
            w.admin,
            'chorus.void_purchase',
            voidArgs('vr-observe', transfer.id),
          ),
        ),
      ).toMatchObject({ code: 'invalid_transition', details: { reason: 'delivered' } });

      const unpaid = await modeArgs(w, 'assist', 'vr-unpaid');
      failed(await invoke('enabled', w.admin, 'chorus.set_coordination_mode', unpaid));
      expect(
        failed(
          await invoke(
            'enabled',
            w.admin,
            'chorus.void_purchase',
            voidArgs('vr-unpaid', `txn_Never${tag()}`),
          ),
        ).code,
      ).toBe('payment_not_found');
      expect(await purchaseState(w, 'vr-unpaid')).toEqual({ state: 'quoted', txn_id: null });

      const stranger = await seated(w.admin.ws, 'stranger');
      expect(
        failed(
          await invoke(
            'enabled',
            stranger,
            'chorus.void_purchase',
            voidArgs('vr-unpaid', `txn_Never${tag()}`),
          ),
        ).code,
      ).toBe('not_found');
    });
  });
});
