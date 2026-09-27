import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject, SharedOSKernel, ToolResult } from '@aicoo/sharedos';
import type { CreditTransfer, LedgerClient } from '@chorus/sharednet-ledger';
import { createFakeLedgerClient, sampleTransfer } from '@chorus/sharednet-ledger/testing';
import {
  createFixture,
  type Actor,
  type Fixture,
  type SessionSeed,
} from '../../../../packages/domain/test/helpers/fixture.ts';
import { RateLimiter } from '../../src/rate-limit.ts';
import { buildAccessContext } from '../../src/sharedos/access-context.ts';
import { createChorusKernel } from '../../src/sharedos/kernel.ts';
import { runInRequestScope, type ChorusRequestScope } from '../../src/sharedos/request-scope.ts';

const BASE = 'https://www.sharednet.ai';
const noopLogger = { error: () => undefined };

describe('Arena tools through the SharedOS kernel (real PostgreSQL as chorus_app, fake ledger)', () => {
  let f: Fixture;
  const transfers: CreditTransfer[] = [];
  let ledgerCalls = 0;
  const ledger: LedgerClient = {
    listTransfers: (args, signal) => {
      ledgerCalls++;
      return createFakeLedgerClient(transfers).listTransfers(args, signal);
    },
  };
  let paid = new RateLimiter({ limit: 1000, windowMs: 60_000 });
  let pulse = new RateLimiter({ limit: 1000, windowMs: 60_000 });
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
      // Read through closures so a test can swap in tight limits.
      limits: {
        paid: { hit: (key: string) => paid.hit(key) } as RateLimiter,
        pulse: { hit: (key: string) => pulse.hit(key) } as RateLimiter,
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
    ws: Actor['ws'];
    external: string;
    payee: { memberId: string; principalId: string };
    buyer: Actor;
    seat: string;
    session: SessionSeed;
  }
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
    const buyer = await seated(ws, 'buyer');
    return {
      ws,
      external,
      payee,
      buyer,
      seat: await seatOf(buyer),
      session: await f.session(buyer),
    };
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
  const toolNames = async (billing: 'enabled' | 'disabled', a: Actor): Promise<string[]> => {
    const scope = scopeOf(a);
    return (
      await kernelFor(billing).listPublishedTools(
        buildAccessContext(scope, randomUUID(), new Date()),
        {
          executionId: 'exec',
        },
      )
    ).tools.map((t) => t.name);
  };
  const failed = (r: ToolResult) => {
    expect(r.status, JSON.stringify(r)).toBe('failed');
    return (
      r as { error: { code: string; retryable?: boolean; details?: Record<string, unknown> } }
    ).error;
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
  const tasksArgs = (w: World, count: number, requestId: string) => ({
    request_id: requestId,
    session_id: w.session.id,
    board_id: w.session.boardId,
    tasks: Array.from({ length: count }, (_, i) => ({
      title: `task ${String(i)}`,
      acceptance_criteria: ['it works'],
    })),
  });

  it('P10 arena.billing_switch: with billing on the free create tools are absent and uncallable; off, they exist', async () => {
    const w = await world('p10');
    const on = await toolNames('enabled', w.buyer);
    const off = await toolNames('disabled', w.buyer);
    for (const name of ['chorus.room_pulse', 'chorus.create_action_board', 'chorus.create_tasks']) {
      expect(on, name).toContain(name);
      expect(off, name).toContain(name);
    }
    expect(on).not.toContain('chorus.create_session');
    expect(on).not.toContain('chorus.create_task');
    expect(off).toContain('chorus.create_session');
    expect(off).toContain('chorus.create_task');

    // Uncallable with billing on: not registered, so SharedOS answers as for any unknown tool, and nothing is created.
    const before = await f.count(`SELECT count(*) AS n FROM sessions WHERE room_id = $1`, [
      w.ws.roomId,
    ]);
    const blocked = await invoke('enabled', w.buyer, 'chorus.create_session', {
      idempotency_key: randomUUID(),
      name: 'free ride',
      board_name: 'b',
    });
    expect(blocked.status).toBe('denied');
    const blockedTask = await invoke('enabled', w.buyer, 'chorus.create_task', {
      idempotency_key: randomUUID(),
      session_id: w.session.id,
      board_id: w.session.boardId,
      title: 'free task',
      acceptance_criteria: ['x'],
    });
    expect(blockedTask.status).toBe('denied');
    expect(
      await f.count(`SELECT count(*) AS n FROM sessions WHERE room_id = $1`, [w.ws.roomId]),
    ).toBe(before);
    // With billing off the free path works, and the paid tools still quote.
    okOut(
      await invoke('disabled', w.buyer, 'chorus.create_session', {
        idempotency_key: randomUUID(),
        name: 'free',
        board_name: 'b',
      }),
    );
    expect(
      failed(await invoke('disabled', w.buyer, 'chorus.create_tasks', tasksArgs(w, 1, 'p10-quote')))
        .code,
    ).toBe('payment_required');
  });

  it('P12 arena.pricing: N tasks quote N credits, the board 8; N=0 and N=21 are invalid_request; nothing is quoted for bad input', async () => {
    const w = await world('p12');
    for (const count of [1, 5, 20]) {
      const error = failed(
        await invoke(
          'enabled',
          w.buyer,
          'chorus.create_tasks',
          tasksArgs(w, count, `p12-${String(count)}`),
        ),
      );
      expect(error.code).toBe('payment_required');
      expect(error.retryable).not.toBe(true);
      expect(error.details).toMatchObject({
        amount: count,
        currency: 'sharednet_credits',
        service: 'create_tasks',
      });
    }
    for (const count of [0, 21]) {
      expect(
        failed(
          await invoke(
            'enabled',
            w.buyer,
            'chorus.create_tasks',
            tasksArgs(w, count, `p12-bad-${String(count)}`),
          ),
        ).code,
      ).toBe('invalid_request');
    }
    const board = failed(
      await invoke('enabled', w.buyer, 'chorus.create_action_board', {
        request_id: 'p12-board',
        session_name: 'Arena',
        board_name: 'Board',
      }),
    );
    expect(board.code).toBe('payment_required');
    expect(board.details).toMatchObject({ amount: 8, service: 'create_action_board' });
    // Bad input is refused BEFORE a purchase exists: an invalid task, an unsupported policy, a paid tool with a stray key.
    const before = await f.count(`SELECT count(*) AS n FROM purchases WHERE workspace_id = $1`, [
      w.ws.id,
    ]);
    const badTask = tasksArgs(w, 1, 'p12-badtask');
    badTask.tasks = [{ title: '', acceptance_criteria: ['x'] }];
    expect(failed(await invoke('enabled', w.buyer, 'chorus.create_tasks', badTask)).code).toBe(
      'invalid_request',
    );
    const credential = failed(
      await invoke('enabled', w.buyer, 'chorus.create_action_board', {
        request_id: 'p12-cred',
        session_name: 's',
        board_name: 'b',
        join_policy: 'session_credential',
      }),
    );
    expect(credential).toMatchObject({
      code: 'invalid_request',
      details: { reason: 'not_supported_yet' },
    });
    const stray = await invoke('enabled', w.buyer, 'chorus.create_tasks', {
      ...tasksArgs(w, 1, 'p12-stray'),
      idempotency_key: randomUUID(),
    });
    expect(stray).toMatchObject({ status: 'failed', error: { code: 'invalid_tool_arguments' } });
    expect(
      await f.count(`SELECT count(*) AS n FROM purchases WHERE workspace_id = $1`, [w.ws.id]),
    ).toBe(before);
  });

  it('paid tools end to end: quote → pay → deliver → replay, for create_tasks and create_action_board', async () => {
    const w = await world('paid');
    const args = tasksArgs(w, 2, 'paid-tasks');
    const quote =
      failed(await invoke('enabled', w.buyer, 'chorus.create_tasks', args)).details ?? {};
    expect(quote).toMatchObject({
      state: 'PAYMENT_REQUIRED',
      amount: 2,
      pay_from_seat: w.seat,
      room_id: w.external,
      payee: { member_id: w.payee.memberId, principal_id: w.payee.principalId },
    });
    expect(quote['warning']).toContain('Payments are final');
    const transfer = pay(w, quote);
    const done = okOut(
      await invoke('enabled', w.buyer, 'chorus.create_tasks', {
        ...args,
        payment_txn_id: transfer.id,
      }),
    );
    expect(done).toMatchObject({
      state: 'DELIVERED',
      service: 'create_tasks',
      amount: 2,
      txn_id: transfer.id,
    });
    expect(typeof done['audit_trace_id']).toBe('string');
    const listed = okOut(
      await invoke('enabled', w.buyer, 'chorus.list_work', { session_id: w.session.id }),
    ) as {
      items: unknown[];
    };
    expect(listed.items).toHaveLength(2);
    // Replay: the same output (a new trace id), no ledger call, no new tasks, no charge.
    const calls = ledgerCalls;
    const again = okOut(
      await invoke('enabled', w.buyer, 'chorus.create_tasks', {
        ...args,
        payment_txn_id: transfer.id,
      }),
    );
    const { audit_trace_id: _a, ...first } = done;
    const { audit_trace_id: _b, ...second } = again;
    expect(second).toEqual(first);
    expect(ledgerCalls).toBe(calls);
    expect(
      (
        okOut(
          await invoke('enabled', w.buyer, 'chorus.list_work', { session_id: w.session.id }),
        ) as { items: unknown[] }
      ).items,
    ).toHaveLength(2);

    // create_action_board: one session, one board, the buyer as participant + manager + administrator.
    const boardArgs = {
      request_id: 'paid-board',
      session_name: 'Paid session',
      board_name: 'Paid board',
    };
    const boardQuote =
      failed(await invoke('enabled', w.buyer, 'chorus.create_action_board', boardArgs)).details ??
      {};
    const boardPaid = pay(w, boardQuote);
    const board = okOut(
      await invoke('enabled', w.buyer, 'chorus.create_action_board', {
        ...boardArgs,
        payment_txn_id: boardPaid.id,
      }),
    ) as { result: { session: { id: string }; membership: { roles: string[] } } };
    expect(board.result.membership.roles).toEqual(['participant', 'manager', 'administrator']);
    expect(
      await f.count(`SELECT count(*) AS n FROM sessions WHERE id = $1 AND room_id = $2`, [
        board.result.session.id,
        w.ws.roomId,
      ]),
    ).toBe(1);
    // The first creation event carries the purchase provenance.
    const [event] = await f.owner<{ payload: { purchase?: { purchase_id: string } } }>(
      `SELECT payload FROM domain_events WHERE aggregate_id = $1 AND event_type = 'session.created'`,
      [board.result.session.id],
    );
    expect(event?.payload.purchase).toMatchObject({
      service: 'create_action_board',
      amount: 8,
      txn_id: boardPaid.id,
    });
  });

  it('P11 arena.pulse: free, read-only, session-scoped, labeled as Chorus state only; a foreign session is not_found', async () => {
    const w = await world('p11');
    // Seed one ready task through the free path.
    okOut(
      await invoke('disabled', w.buyer, 'chorus.create_task', {
        idempotency_key: randomUUID(),
        session_id: w.session.id,
        board_id: w.session.boardId,
        title: 'seeded',
        acceptance_criteria: ['x'],
      }),
    );
    const stranger = await seated(w.ws, 'stranger');
    const events = () =>
      f.count(`SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1`, [w.ws.id]);
    const commands = () =>
      f.count(`SELECT count(*) AS n FROM commands WHERE workspace_id = $1`, [w.ws.id]);
    const before = {
      e: await events(),
      c: await commands(),
      p: await f.count(`SELECT count(*) AS n FROM purchases WHERE workspace_id = $1`, [w.ws.id]),
    };
    const out = okOut(await invoke('enabled', w.buyer, 'chorus.room_pulse', {})) as {
      coverage: string;
      sessions: { session_id: string; counts: { ready_unowned: number } }[];
    };
    expect(out.coverage).toBe('chorus_state_only');
    expect(out.sessions.find((s) => s.session_id === w.session.id)?.counts.ready_unowned).toBe(1);
    expect(typeof out['audit_trace_id' as never]).toBe('string');
    // One session filter works; a session the caller is not in is not_found (and reveals nothing).
    okOut(await invoke('enabled', w.buyer, 'chorus.room_pulse', { session_id: w.session.id }));
    expect(
      failed(await invoke('enabled', stranger, 'chorus.room_pulse', { session_id: w.session.id }))
        .code,
    ).toBe('not_found');
    expect(
      (okOut(await invoke('enabled', stranger, 'chorus.room_pulse', {})) as { sessions: unknown[] })
        .sessions,
    ).toEqual([]);
    // It never mutates and never charges.
    expect({
      e: await events(),
      c: await commands(),
      p: await f.count(`SELECT count(*) AS n FROM purchases WHERE workspace_id = $1`, [w.ws.id]),
    }).toEqual(before);
  });

  it('arena.rate_limits: paid tools and the pulse are limited per actor, with a retryable rate_limited and a wait time', async () => {
    const w = await world('rate');
    const other = await seated(w.ws, 'other');
    await f.join(w.session, other);
    paid = new RateLimiter({ limit: 2, windowMs: 60_000 });
    pulse = new RateLimiter({ limit: 3, windowMs: 60_000 });
    try {
      const statuses: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await invoke(
          'enabled',
          w.buyer,
          'chorus.create_tasks',
          tasksArgs(w, 1, `rate-${String(i)}`),
        );
        statuses.push(
          r.status === 'failed' ? (r as { error: { code: string } }).error.code : r.status,
        );
      }
      expect(statuses).toEqual([
        'payment_required',
        'payment_required',
        'rate_limited',
        'rate_limited',
      ]);
      const limited = failed(
        await invoke('enabled', w.buyer, 'chorus.create_tasks', tasksArgs(w, 1, 'rate-x')),
      );
      expect(limited.retryable).toBe(true);
      expect(Number(limited.details?.['retry_after_seconds'])).toBeGreaterThan(0);
      // Another actor has its own budget; the pulse has its own bucket.
      expect(
        failed(
          await invoke('enabled', other, 'chorus.create_tasks', {
            ...tasksArgs(w, 1, 'rate-other'),
            session_id: w.session.id,
          }),
        ).code,
      ).not.toBe('rate_limited');
      const pulses: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await invoke('enabled', w.buyer, 'chorus.room_pulse', {});
        pulses.push(
          r.status === 'failed' ? (r as { error: { code: string } }).error.code : r.status,
        );
      }
      expect(pulses).toEqual([
        'succeeded',
        'succeeded',
        'succeeded',
        'rate_limited',
        'rate_limited',
      ]);
    } finally {
      paid = new RateLimiter({ limit: 1000, windowMs: 60_000 });
      pulse = new RateLimiter({ limit: 1000, windowMs: 60_000 });
    }
  });
});
