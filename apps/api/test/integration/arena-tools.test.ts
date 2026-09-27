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

  it('S1-6 arena.task_shape: a task takes only its own keys, and field errors say which task', async () => {
    const w = await world('shape');
    const before = await f.count(`SELECT count(*) AS n FROM purchases WHERE workspace_id = $1`, [
      w.ws.id,
    ]);
    const call = async (tasks: unknown[]) => {
      const args = { ...tasksArgs(w, 1, `shape-${tag()}`), tasks };
      return failed(await invoke('enabled', w.buyer, 'chorus.create_tasks', args));
    };
    const good = { title: 'ok', acceptance_criteria: ['c'] };
    // Keys outside the six are refused, including the ones the call itself owns.
    for (const key of ['session_id', 'board_id', 'state', 'owner_actor_id', 'request_id']) {
      const error = await call([{ ...good, [key]: 'x' }]);
      expect(error.code, key).toBe('invalid_request');
      expect(error.details?.['field'], key).toBe(`tasks[0].${key}`);
    }
    // A field error names the task: tasks[i].<field>.
    const second = await call([good, { title: '', acceptance_criteria: ['c'] }]);
    expect(second).toMatchObject({ code: 'invalid_request', details: { field: 'tasks[1].title' } });
    const criteria = await call([good, good, { title: 't', acceptance_criteria: [] }]);
    expect(criteria.details?.['field']).toBe('tasks[2].acceptance_criteria');
    expect((criteria as { message?: string }).message ?? '').toMatch(/^tasks\[2\]\./);
    const notObject = await call([good, 'nope']);
    // A non-object item never reaches the domain: the tool schema refuses it first.
    expect(notObject.code).toBe('invalid_tool_arguments');
    // Nothing was quoted for any of it. (Malformed calls do count against the actor's rate limit.)
    expect(
      await f.count(`SELECT count(*) AS n FROM purchases WHERE workspace_id = $1`, [w.ws.id]),
    ).toBe(before);
  });

  it('S1-6 arena.create_tasks_authorization: no purchase for a non-member, a removed member, or a member who left', async () => {
    const w = await world('authz');
    const stranger = await seated(w.ws, 'stranger'); // in the room, not in the session
    const revoked = await seated(w.ws, 'revoked');
    await f.join(w.session, revoked); // a participant, then...
    await f.owner(
      `UPDATE session_members SET removed_at = now() WHERE session_id = $1 AND actor_id = $2`,
      [w.session.id, revoked.id],
    );
    // A member who joined and then LEFT holds no participant role any more.
    const left = await seated(w.ws, 'left');
    await f.join(w.session, left);
    okOut(
      await invoke('enabled', left, 'chorus.leave_session', {
        idempotency_key: randomUUID(),
        session_id: w.session.id,
      }),
    );
    for (const [label, actor] of [
      ['non-member', stranger],
      ['removed member', revoked],
      ['member who left', left],
    ] as const) {
      const result = await invoke(
        'enabled',
        actor,
        'chorus.create_tasks',
        tasksArgs(w, 1, `authz-${label.replaceAll(' ', '-')}`),
      );
      expect(['denied', 'failed'], label).toContain(result.status);
      const code = (result as { error: { code: string } }).error.code;
      expect(
        ['tool_unavailable', 'no_matching_grant', 'not_found', 'action_forbidden'],
        `${label}: ${code}`,
      ).toContain(code);
      expect(
        await f.count(`SELECT count(*) AS n FROM purchases WHERE actor_id = $1`, [actor.id]),
        label,
      ).toBe(0);
    }
    expect(
      await f.count(
        `SELECT count(*) AS n FROM work_items WHERE session_id = $1 AND kind = 'task'`,
        [w.session.id],
      ),
    ).toBe(0);
  });

  it('S1-6 arena.all_or_nothing: one failing task insert leaves no tasks, the purchase quoted and the txn unclaimed', async () => {
    const w = await world('atomic');
    const args = {
      ...tasksArgs(w, 3, 'atomic-tasks'),
      tasks: [
        { title: 'first', acceptance_criteria: ['c'] },
        { title: 'BOOM', acceptance_criteria: ['c'] },
        { title: 'third', acceptance_criteria: ['c'] },
      ],
    };
    const quote =
      failed(await invoke('enabled', w.buyer, 'chorus.create_tasks', args)).details ?? {};
    const transfer = pay(w, quote);
    await f.owner(`CREATE FUNCTION s16_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.title = 'BOOM' THEN RAISE EXCEPTION 'injected insert failure'; END IF; RETURN NEW; END $$`);
    await f.owner(
      `CREATE TRIGGER s16_boom BEFORE INSERT ON work_items FOR EACH ROW EXECUTE FUNCTION s16_boom()`,
    );
    try {
      const result = await invoke('enabled', w.buyer, 'chorus.create_tasks', {
        ...args,
        payment_txn_id: transfer.id,
      });
      expect(result.status).toBe('failed'); // the second insert failed AFTER the first task was written
      const tasks = () =>
        f.count(`SELECT count(*) AS n FROM work_items WHERE session_id = $1 AND kind = 'task'`, [
          w.session.id,
        ]);
      expect(await tasks()).toBe(0);
      const [row] = await f.owner<{ state: string; txn_id: string | null }>(
        `SELECT state, txn_id FROM purchases WHERE id = $1`,
        [quote['purchase_id']],
      );
      expect(row).toEqual({ state: 'quoted', txn_id: null });
      expect(
        await f.count(`SELECT count(*) AS n FROM purchases WHERE txn_id = $1`, [transfer.id]),
      ).toBe(0);
      // With the fault gone, the same request and txn deliver all three, once.
      await f.owner(`DROP TRIGGER s16_boom ON work_items`);
      const done = okOut(
        await invoke('enabled', w.buyer, 'chorus.create_tasks', {
          ...args,
          payment_txn_id: transfer.id,
        }),
      );
      expect(done['state']).toBe('DELIVERED');
      expect(await tasks()).toBe(3);
    } finally {
      await f.owner(`DROP TRIGGER IF EXISTS s16_boom ON work_items`);
      await f.owner(`DROP FUNCTION IF EXISTS s16_boom()`);
    }
  });

  it('S1-6 arena.provenance: every task.created of a delivery carries the purchase, and the tasks stay claimable', async () => {
    const w = await world('prov');
    const args = tasksArgs(w, 3, 'prov-tasks');
    const quote =
      failed(await invoke('enabled', w.buyer, 'chorus.create_tasks', args)).details ?? {};
    const transfer = pay(w, quote);
    const done = okOut(
      await invoke('enabled', w.buyer, 'chorus.create_tasks', {
        ...args,
        payment_txn_id: transfer.id,
      }),
    ) as {
      result: { tasks: { id: string; version: number }[] };
    };
    const events = await f.owner<{
      aggregate_id: string;
      payload: { purchase?: Record<string, unknown> };
    }>(
      `SELECT aggregate_id, payload FROM domain_events WHERE session_id = $1 AND event_type = 'task.created'`,
      [w.session.id],
    );
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.aggregate_id))).toEqual(
      new Set(done.result.tasks.map((t) => t.id)),
    );
    for (const event of events) {
      expect(event.payload.purchase).toEqual({
        purchase_id: quote['purchase_id'],
        service: 'create_tasks',
        amount: 3,
        txn_id: transfer.id,
      });
    }
    // No aggregate version was consumed by the provenance: the first real command still gets version 2.
    const first = done.result.tasks[0];
    expect(first?.version).toBe(1);
    okOut(
      await invoke('enabled', w.buyer, 'chorus.claim', {
        idempotency_key: randomUUID(),
        session_id: w.session.id,
        task_id: first?.id,
        expected_version: 1,
      }),
    );
  });
});
