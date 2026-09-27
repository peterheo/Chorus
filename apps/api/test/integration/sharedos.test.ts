import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { SharedOSKernel, ToolResult } from '@aicoo/sharedos';
import { removeMember, revokeRole, type Uuid } from '@chorus/domain';
import {
  createFixture,
  type Actor,
  type Fixture,
  type Workspace,
} from '../../../../packages/domain/test/helpers/fixture.ts';
import { buildAccessContext } from '../../src/sharedos/access-context.ts';
import { createPgAuditSink } from '../../src/sharedos/audit-sink.ts';
import { createChorusGrantSource } from '../../src/sharedos/grant-source.ts';
import { createChorusKernel } from '../../src/sharedos/kernel.ts';
import { runInRequestScope, type ChorusRequestScope } from '../../src/sharedos/request-scope.ts';

const noopLogger = { error: () => undefined };

describe('SharedOS host: kernel level (real PostgreSQL, as chorus_app)', () => {
  let f: Fixture;
  let ws: Workspace;
  let kernel: SharedOSKernel;
  let audit: { failures: () => number; flush: () => Promise<void> };

  beforeAll(async () => {
    f = await createFixture({ poolMax: 10 });
    ws = await f.workspace('sharedos');
    ({ kernel, audit } = createChorusKernel({
      pool: f.pool,
      leaseDurationSeconds: 900,
      gitCommit: 'test',
      logger: noopLogger,
    }));
  });
  afterAll(async () => {
    await audit.flush();
    await f.close();
  });

  const scopeOf = (a: Actor): ChorusRequestScope => ({
    workspaceId: a.ws.id,
    actorId: a.id,
    instanceId: a.instanceId,
    roomId: a.ws.roomId,
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const ctxOf = (a: Actor, traceId: string = randomUUID()) =>
    buildAccessContext(scopeOf(a), traceId, new Date());
  const call = async (
    a: Actor,
    tool: string,
    args: Record<string, unknown>,
    over: { scope?: ChorusRequestScope | null; traceId?: string } = {},
  ): Promise<ToolResult> => {
    const traceId = over.traceId ?? randomUUID();
    const context = ctxOf(a, traceId);
    const invocation = {
      id: randomUUID(),
      tool,
      arguments: {
        ...(tool.match(/list_|get_/) === null && !tool.endsWith('whoami')
          ? { idempotency_key: randomUUID() }
          : {}),
        ...args,
      },
      traceId,
      requestedAt: context.now,
    };
    if (over.scope === null) return kernel.invokeTool(context, invocation);
    return runInRequestScope(over.scope ?? scopeOf(a), () =>
      kernel.invokeTool(context, invocation),
    );
  };
  const okOutput = (r: ToolResult): Record<string, unknown> => {
    expect(r.status, JSON.stringify(r)).toBe('succeeded');
    return (r as { output: Record<string, unknown> }).output;
  };
  const toolNames = async (a: Actor): Promise<string[]> =>
    (await kernel.listPublishedTools(ctxOf(a), { executionId: 'exec' })).tools.map((t) => t.name);
  const commandCount = () => f.count('SELECT count(*) AS n FROM commands');

  const ADMIN_ONLY = [
    'chorus.grant_role',
    'chorus.revoke_role',
    'chorus.set_session_policy',
    'chorus.set_coordination_mode',
    'chorus.remove_member',
  ];

  it('K1 sharedos.discovery: each caller sees exactly the tools their roles allow', async () => {
    const admin = await f.actor(ws, 'k1-admin');
    const session = await f.session(admin);
    const participant = await f.actor(ws, 'k1-participant');
    await f.join(session, participant);
    const roomOnly = await f.actor(ws, 'k1-room-only');

    const asParticipant = await toolNames(participant);
    for (const name of ADMIN_ONLY) expect(asParticipant).not.toContain(name);
    expect(asParticipant).toEqual(
      expect.arrayContaining([
        'chorus.claim',
        'chorus.list_work',
        'chorus.review',
        'chorus.leave_session',
        'chorus.coordination_status',
        'chorus.update_conversation_object',
      ]),
    );
    expect(asParticipant).not.toContain('chorus.complete');
    expect(asParticipant).not.toContain('chorus.create_board');

    const asAdmin = await toolNames(admin);
    expect(asAdmin).toEqual(
      expect.arrayContaining([...ADMIN_ONLY, 'chorus.complete', 'chorus.create_board']),
    );
    expect(asAdmin).toHaveLength(36); // 27 + room_pulse, create_action_board, create_tasks, and 6 conversation tools

    expect(await toolNames(roomOnly)).toEqual([
      'chorus.create_action_board',
      'chorus.create_session',
      'chorus.join_session',
      'chorus.list_sessions',
      'chorus.room_pulse',
      'chorus.whoami',
    ]);
    // A stranger to the room sees nothing at all.
    const stranger = await f.actor(ws, 'k1-stranger', { inRoom: false });
    expect(await toolNames(stranger)).toEqual([]);
  });

  it('CC-2d-1 coordination mode is administrator-only and starts at the watcher checkpoint', async () => {
    const admin = await f.actor(ws, 'coordination-mode-admin');
    const session = await f.session(admin);
    const participant = await f.actor(ws, 'coordination-mode-participant');
    await f.join(session, participant);
    const sealedMemberId = 'i_SealedSeatMember01';
    await f.owner(
      "UPDATE rooms SET provider = 'sharednet', external_room_id = 'rom_ModeTest01' WHERE id = $1",
      [session.roomId],
    );
    await f.owner(
      `INSERT INTO sharednet_seats
         (workspace_id, room_id, member_id, principal_id, token_ciphertext, token_nonce, key_id)
       VALUES ($1, $2, $3, 'p_SealedPrincipal01', $4, $5, 'deadbeef')`,
      [
        ws.id,
        session.roomId,
        sealedMemberId,
        Buffer.from('sealed-token-sentinel'),
        Buffer.alloc(12, 7),
      ],
    );
    await f.owner(
      'INSERT INTO sharednet_cursors (workspace_id, room_id, last_sequence) VALUES ($1, $2, 42)',
      [ws.id, session.roomId],
    );

    expect(
      await call(participant, 'chorus.set_coordination_mode', {
        session_id: session.id,
        mode: 'observe',
        expected_version: 2,
      }),
    ).toMatchObject({ status: 'denied' });

    const observe = okOutput(
      await call(admin, 'chorus.set_coordination_mode', {
        session_id: session.id,
        mode: 'observe',
        expected_version: 2,
      }),
    );
    const serialized = JSON.stringify(observe);
    expect(serialized).not.toContain('sealed-token-sentinel');
    expect(serialized).not.toContain('token_ciphertext');
    expect(serialized).not.toContain('token_nonce');
    expect(serialized).not.toContain('deadbeef');
    expect(serialized).not.toContain(sealedMemberId);
    const cursor = async () =>
      Number(
        (
          await f.owner<{ cursor: string }>(
            'SELECT cursor FROM conversation_engine_state WHERE session_id = $1',
            [session.id],
          )
        )[0]?.cursor,
      );
    expect(await cursor()).toBe(42);

    await f.owner('UPDATE sharednet_cursors SET last_sequence = 57 WHERE room_id = $1', [
      session.roomId,
    ]);
    okOutput(
      await call(admin, 'chorus.set_coordination_mode', {
        session_id: session.id,
        mode: 'assist',
        expected_version: 3,
      }),
    );
    expect(await cursor()).toBe(57);

    await f.owner('UPDATE conversation_engine_state SET cursor = 120 WHERE session_id = $1', [
      session.id,
    ]);
    await f.owner('UPDATE sharednet_cursors SET last_sequence = 100 WHERE room_id = $1', [
      session.roomId,
    ]);
    okOutput(
      await call(admin, 'chorus.set_coordination_mode', {
        session_id: session.id,
        mode: 'observe',
        expected_version: 4,
      }),
    );
    expect(await cursor()).toBe(120);

    await f.owner('UPDATE sharednet_cursors SET last_sequence = 80 WHERE room_id = $1', [
      session.roomId,
    ]);
    okOutput(
      await call(admin, 'chorus.set_coordination_mode', {
        session_id: session.id,
        mode: 'off',
        expected_version: 5,
      }),
    );
    expect(await cursor()).toBe(120);
    const [row] = await f.owner<{ coordination_mode: string }>(
      'SELECT coordination_mode FROM sessions WHERE id = $1',
      [session.id],
    );
    expect(row?.coordination_mode).toBe('off');
  });

  it('K2 sharedos.enforcement.cross_session: another session is denied by SharedOS before any domain call', async () => {
    const a = await f.actor(ws, 'k2-a');
    const b = await f.actor(ws, 'k2-b');
    const sa = await f.session(a);
    const sb = await f.session(b);
    const before = await commandCount();
    const attempts: [string, Record<string, unknown>][] = [
      ['chorus.get_session', { session_id: sb.id }],
      ['chorus.list_work', { session_id: sb.id }],
      [
        'chorus.create_task',
        { session_id: sb.id, board_id: sb.boardId, title: 't', acceptance_criteria: ['c'] },
      ],
      ['chorus.claim', { session_id: sb.id, task_id: randomUUID(), expected_version: 1 }],
      ['chorus.set_session_policy', { session_id: sb.id, expected_version: 2, name: 'x' }],
      [
        'chorus.review',
        {
          session_id: sb.id,
          review_id: randomUUID(),
          expected_version: 1,
          verdict: 'approved',
          content_sha256: 'a'.repeat(64),
        },
      ],
    ];
    for (const [tool, args] of attempts) {
      const r = await call(a, tool, args);
      expect(r, tool).toMatchObject({ status: 'denied', error: { code: 'no_matching_grant' } });
    }
    expect(await commandCount()).toBe(before);
    // Their own session works.
    okOutput(await call(a, 'chorus.get_session', { session_id: sa.id }));
  });

  it('K2b sharedos.enforcement.cross_binding: a session the caller is authorized for cannot address an item of another session', async () => {
    const owner = await f.actor(ws, 'k2b-owner');
    const worker = await f.actor(ws, 'k2b-worker');
    const reviewer = await f.actor(ws, 'k2b-reviewer');
    const m = await f.actor(ws, 'k2b-m');
    const sa = await f.session(m); // m manages session A
    const sb = await f.session(owner);
    await f.join(sb, worker);
    await f.join(sb, reviewer);
    await f.join(sb, m); // m is only a participant in B
    const task = okOutput(
      await call(owner, 'chorus.create_task', {
        session_id: sb.id,
        board_id: sb.boardId,
        title: 'B task',
        acceptance_criteria: ['c'],
      }),
    ) as { task: { id: string; version: number } };
    const claimed = okOutput(
      await call(worker, 'chorus.claim', {
        session_id: sb.id,
        task_id: task.task.id,
        expected_version: task.task.version,
      }),
    ) as { version: number; fence: number };
    const submitted = okOutput(
      await call(worker, 'chorus.submit_result', {
        session_id: sb.id,
        task_id: task.task.id,
        expected_version: claimed.version,
        fence: claimed.fence,
        content: 'done',
        content_type: 'text/plain',
        criteria_mapping: [{ criterion: 0, note: 'ok' }],
      }),
    ) as { version: number; content_sha256: string };
    const requested = okOutput(
      await call(worker, 'chorus.request_review', {
        session_id: sb.id,
        task_id: task.task.id,
        expected_version: submitted.version,
        revision: 1,
        reviewer_actor_id: reviewer.id,
      }),
    ) as { review: { id: string; version: number } };
    const snapshot = async () =>
      JSON.stringify(
        await f.owner(
          `SELECT id, state, version, owner_actor_id FROM work_items WHERE session_id = $1 ORDER BY id`,
          [sb.id],
        ),
      );
    const before = await snapshot();
    const commands = await commandCount();

    // Every call is authorized (m holds the role in session A) but names session A with an item of session B.
    const attempts: [string, Record<string, unknown>][] = [
      [
        'chorus.complete',
        { session_id: sa.id, task_id: task.task.id, expected_version: submitted.version + 1 },
      ],
      ['chorus.get_task', { session_id: sa.id, task_id: task.task.id }],
      ['chorus.get_result', { session_id: sa.id, task_id: task.task.id, revision: 1 }],
      [
        'chorus.review',
        {
          session_id: sa.id,
          review_id: requested.review.id,
          expected_version: requested.review.version,
          verdict: 'approved',
          content_sha256: submitted.content_sha256,
        },
      ],
    ];
    for (const [tool, args] of attempts) {
      expect(await call(m, tool, args), tool).toMatchObject({
        status: 'failed',
        error: { code: 'not_found' },
      });
    }
    expect(await commandCount()).toBe(commands);
    expect(await snapshot()).toBe(before);
  });

  it('K3 sharedos.enforcement.revocation: role, session and room changes take effect on the next call', async () => {
    const admin = await f.actor(ws, 'k3-admin');
    const session = await f.session(admin);
    const second = await f.actor(ws, 'k3-second');
    await f.join(session, second, ['participant', 'administrator']);
    const policy = (a: Actor, version: number) =>
      call(a, 'chorus.set_session_policy', {
        session_id: session.id,
        expected_version: version,
        name: `n${String(version)}`,
      });
    const version = async () =>
      Number(
        (
          await f.owner<{ version: number }>('SELECT version FROM sessions WHERE id = $1', [
            session.id,
          ])
        )[0]?.version,
      );

    okOutput(await policy(second, await version()));
    await revokeRole(admin.ctx(), {
      session_id: session.id,
      actor_id: second.id,
      role: 'administrator',
    });
    // The tool is no longer even discoverable to them: SharedOS answers `tool_unavailable`.
    expect(await policy(second, await version())).toMatchObject({
      status: 'denied',
      error: { code: 'tool_unavailable' },
    });
    expect(await toolNames(second)).not.toContain('chorus.set_session_policy');

    await removeMember(admin.ctx(), { session_id: session.id, actor_id: second.id });
    for (const [tool, args] of [
      ['chorus.get_session', { session_id: session.id }],
      ['chorus.list_work', { session_id: session.id }],
      ['chorus.leave_session', { session_id: session.id }],
    ] as const) {
      expect(await call(second, tool, args), tool).toMatchObject({ status: 'denied' });
    }

    const third = await f.actor(ws, 'k3-third');
    await f.join(session, third);
    okOutput(await call(third, 'chorus.get_session', { session_id: session.id }));
    await f.owner('UPDATE room_members SET removed_at = now() WHERE actor_id = $1', [third.id]);
    for (const tool of ['chorus.get_session', 'chorus.list_sessions']) {
      expect(
        await call(third, tool, tool === 'chorus.list_sessions' ? {} : { session_id: session.id }),
        tool,
      ).toMatchObject({ status: 'denied' });
    }
    expect(await toolNames(third)).toEqual([]);
  });

  it("K4 sharedos.grant_source.shape: exact grants, only the caller's, and fail closed on a foreign context", async () => {
    const admin = await f.actor(ws, 'k4-admin');
    const s1 = await f.session(admin);
    const s2 = await f.session(admin);
    const other = await f.actor(ws, 'k4-other');
    await f.session(other);
    const source = createChorusGrantSource(f.pool);
    const signal = new AbortController().signal;
    const now = new Date();
    const context = buildAccessContext(scopeOf(admin), 'trace-k4', now);
    const grants = await source.load(context, signal);
    const [sv1, sv2] = await Promise.all(
      [s1, s2].map(async (s) =>
        Number(
          (
            await f.owner<{ version: number }>(
              'SELECT version FROM session_members WHERE session_id = $1 AND actor_id = $2',
              [s.id, admin.id],
            )
          )[0]?.version,
        ),
      ),
    );
    const ordered = [s1, s2].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(grants.map((g) => g.id)).toEqual([
      `room:${ws.roomId}:${admin.id}`,
      ...ordered.map((s) => `session:${s.id}:${admin.id}:v${String(s === s1 ? sv1 : sv2)}`),
      `discover:${ws.roomId}:${admin.id}:v${String(Math.max(sv1 ?? 0, sv2 ?? 0))}`,
    ]);
    for (const g of grants) {
      expect(g).toMatchObject({
        namespaceId: ws.id,
        subject: { kind: 'agent', agentId: admin.id },
        issuer: { kind: 'service', serviceId: 'chorus' },
        constraints: { purposes: ['chorus.work'] },
      });
      expect(g.constraints).not.toHaveProperty('maxUses');
      expect(g.constraints).not.toHaveProperty('expiresAt');
      expect(Date.parse(g.issuedAt)).toBeLessThanOrEqual(now.getTime() - 60_000);
    }
    expect(grants[0]?.capabilities).toEqual([
      {
        resource: { namespace: 'chorus', path: ['room'] },
        actions: ['read_sessions', 'create_session', 'join_session', 'pulse'],
        scope: 'exact',
      },
    ]);
    const sessionGrant = grants[1];
    expect(sessionGrant?.capabilities[0]).toMatchObject({
      scope: 'descendants',
      resource: { namespace: 'chorus', path: ['sessions', ordered[0]?.id] },
    });
    expect(sessionGrant?.capabilities[0]?.actions).toEqual(
      expect.arrayContaining(['read', 'claim', 'complete', 'create_board', 'administer']),
    );
    const discovery = grants[grants.length - 1];
    expect(discovery?.capabilities[0]).toMatchObject({
      scope: 'exact',
      resource: { namespace: 'chorus', path: [] },
    });
    expect(discovery?.capabilities[0]?.actions).toEqual(
      expect.arrayContaining(['read_sessions', 'administer']),
    );
    // Only the caller's own memberships.
    expect(JSON.stringify(grants)).not.toContain(other.id);

    expect(
      await source.load(
        { ...context, authority: { kind: 'service', serviceId: 'someone-else' } },
        signal,
      ),
    ).toEqual([]);
    expect(
      await source.load({ ...context, authority: { kind: 'agent', agentId: admin.id } }, signal),
    ).toEqual([]);
    expect(
      await source.load({ ...context, actor: { kind: 'human', userId: 'u' } }, signal),
    ).toEqual([]);
    // A room-only member gets the room and discovery grants and no session grant.
    const roomOnly = await f.actor(ws, 'k4-room-only');
    const roomGrants = await source.load(buildAccessContext(scopeOf(roomOnly), 't', now), signal);
    expect(roomGrants.map((g) => g.id.split(':')[0])).toEqual(['room', 'discover']);
  });

  it('K5 sharedos.issued_at: a member who joined a moment ago can call a session tool immediately', async () => {
    const admin = await f.actor(ws, 'k5-admin');
    const session = await f.session(admin);
    const joiner = await f.actor(ws, 'k5-joiner');
    okOutput(await call(joiner, 'chorus.join_session', { session_id: session.id }));
    okOutput(await call(joiner, 'chorus.get_session', { session_id: session.id }));
    okOutput(await call(joiner, 'chorus.list_boards', { session_id: session.id }));
  });

  it('K6 sharedos.audit_sink: allowed and denied calls are audited, without content or secrets; a failing sink never breaks a call', async () => {
    const admin = await f.actor(ws, 'k6-admin');
    const session = await f.session(admin);
    const other = await f.actor(ws, 'k6-other');
    const otherSession = await f.session(other);
    const allowedTrace = randomUUID();
    const deniedTrace = randomUUID();
    okOutput(
      await call(
        admin,
        'chorus.create_task',
        {
          session_id: session.id,
          board_id: session.boardId,
          title: 'TOP-SECRET-TITLE',
          body: 'SECRET-BODY-CONTENT',
          acceptance_criteria: ['SECRET-CRITERION'],
        },
        { traceId: allowedTrace },
      ),
    );
    expect(
      await call(
        admin,
        'chorus.get_session',
        { session_id: otherSession.id },
        { traceId: deniedTrace },
      ),
    ).toMatchObject({ status: 'denied' });
    await audit.flush();
    for (const trace of [allowedTrace, deniedTrace]) {
      const rows = await f.owner<{ workspace_id: string; event: Record<string, unknown> }>(
        `SELECT workspace_id, event FROM sharedos_audit_events WHERE event ->> 'traceId' = $1`,
        [trace],
      );
      expect(rows.length, trace).toBeGreaterThan(0);
      for (const row of rows) expect(row.workspace_id).toBe(ws.id);
      const text = JSON.stringify(rows.map((r) => r.event));
      for (const secret of [
        'TOP-SECRET-TITLE',
        'SECRET-BODY-CONTENT',
        'SECRET-CRITERION',
        'cht_',
        'cvs_',
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    const outcomes = (
      await f.owner<{ outcome: string }>(
        `SELECT event ->> 'outcome' AS outcome FROM sharedos_audit_events WHERE event ->> 'traceId' = $1`,
        [deniedTrace],
      )
    ).map((r) => r.outcome);
    expect(outcomes).toContain('denied');

    // A sink whose database is unreachable counts the failure and never throws into the caller.
    const errors: Record<string, unknown>[] = [];
    const broken = createPgAuditSink(
      { connect: () => Promise.reject(new Error('down')) } as unknown as pg.Pool,
      { error: (obj) => void errors.push(obj) },
    );
    await expect(
      broken.sink.record({
        version: '1',
        id: 'e1',
        type: 'tool.invoked',
        outcome: 'succeeded',
        at: new Date().toISOString(),
        traceId: 't',
        namespaceId: ws.id,
        actor: { kind: 'agent', agentId: 'a' },
        authority: { kind: 'service', serviceId: 'chorus' },
        owner: { kind: 'group', conversationId: 'r' },
        purpose: 'chorus.work',
      }),
    ).resolves.toBeUndefined();
    await broken.flush();
    expect(broken.failures()).toBe(1);
    expect(JSON.stringify(errors)).not.toContain('chorus.work');
  });

  it('K9 sharedos.scope_guard: no request scope, or a scope for someone else, fails closed with no domain call', async () => {
    const admin = await f.actor(ws, 'k9-admin');
    const session = await f.session(admin);
    const intruder = await f.actor(ws, 'k9-intruder');
    const before = await commandCount();
    const args = { session_id: session.id, name: 'x' };
    expect(await call(admin, 'chorus.create_board', args, { scope: null })).toMatchObject({
      status: 'failed',
      error: { code: 'internal_error' },
    });
    expect(
      await call(admin, 'chorus.create_board', args, { scope: scopeOf(intruder) }),
    ).toMatchObject({ status: 'failed', error: { code: 'internal_error' } });
    expect(
      await call(admin, 'chorus.get_session', { session_id: session.id }, { scope: null }),
    ).toMatchObject({ status: 'failed', error: { code: 'internal_error' } });
    // A scope whose room is not the authorized context's room also fails closed.
    expect(
      await call(
        admin,
        'chorus.get_session',
        { session_id: session.id },
        { scope: { ...scopeOf(admin), roomId: randomUUID() as Uuid } },
      ),
    ).toMatchObject({ status: 'failed', error: { code: 'internal_error' } });
    expect(await commandCount()).toBe(before);
  });

  it('K8 sharedos.arguments: a bad call is rejected by the kernel as invalid_tool_arguments, before any domain call', async () => {
    const admin = await f.actor(ws, 'k8-admin');
    const session = await f.session(admin);
    const before = await commandCount();
    for (const args of [
      { session_id: session.id },
      { session_id: session.id, name: 5 },
      { session_id: session.id, name: 'x', surprise: true },
    ]) {
      expect(await call(admin, 'chorus.create_board', args)).toMatchObject({
        status: 'failed',
        error: { code: 'invalid_tool_arguments' },
      });
    }
    expect(await commandCount()).toBe(before);
  });

  it('K7 (through the kernel): real domain refusals keep their exact error codes', async () => {
    const admin = await f.actor(ws, 'k7-admin');
    const session = await f.session(admin);
    const worker = await f.actor(ws, 'k7-worker');
    await f.join(session, worker);
    const created = okOutput(
      await call(admin, 'chorus.create_task', {
        session_id: session.id,
        board_id: session.boardId,
        title: 't',
        acceptance_criteria: ['c'],
      }),
    ) as { task: { id: string; version: number } };
    const t = created.task;
    const failedWith = (r: ToolResult, code: string): void => {
      expect(r).toMatchObject({ status: 'failed', error: { code } });
    };

    failedWith(
      await call(worker, 'chorus.get_task', { session_id: session.id, task_id: randomUUID() }),
      'not_found',
    );
    failedWith(
      await call(worker, 'chorus.claim', {
        session_id: session.id,
        task_id: t.id,
        expected_version: t.version + 5,
      }),
      'version_conflict',
    );
    failedWith(
      await call(worker, 'chorus.create_task', {
        session_id: session.id,
        board_id: session.boardId,
        title: '',
        acceptance_criteria: ['c'],
      }),
      'invalid_request',
    );
    const key = randomUUID();
    okOutput(
      await call(worker, 'chorus.claim', {
        session_id: session.id,
        task_id: t.id,
        expected_version: t.version,
        idempotency_key: key,
      }),
    );
    failedWith(
      await call(worker, 'chorus.claim', {
        session_id: session.id,
        task_id: t.id,
        expected_version: t.version + 1,
        idempotency_key: key,
      }),
      'idempotency_conflict',
    );
    failedWith(
      await call(admin, 'chorus.claim', {
        session_id: session.id,
        task_id: t.id,
        expected_version: t.version + 1,
      }),
      'owner_conflict',
    );
    failedWith(
      await call(admin, 'chorus.complete', {
        session_id: session.id,
        task_id: t.id,
        expected_version: t.version + 1,
      }),
      'invalid_transition',
    );
  });

  it('K10 sharedos.lifecycle_via_kernel: a whole flow through invokeTool alone, every output traced', async () => {
    const owner = await f.actor(ws, 'k10-owner');
    const worker = await f.actor(ws, 'k10-worker');
    const reviewer = await f.actor(ws, 'k10-reviewer');
    const traces: string[] = [];
    const run = async (a: Actor, tool: string, args: Record<string, unknown>) => {
      const traceId = randomUUID();
      const out = okOutput(await call(a, tool, args, { traceId }));
      expect(out['audit_trace_id']).toBe(traceId);
      traces.push(traceId);
      return out;
    };
    const created = (await run(owner, 'chorus.create_session', {
      name: 'Flow',
      board_name: 'Board',
    })) as {
      session: { id: string };
      board: { id: string };
    };
    const sid = created.session.id;
    await run(worker, 'chorus.join_session', { session_id: sid });
    await run(reviewer, 'chorus.join_session', { session_id: sid });
    const task = (
      (await run(owner, 'chorus.create_task', {
        session_id: sid,
        board_id: created.board.id,
        title: 'Do it',
        acceptance_criteria: ['Works'],
      })) as { task: { id: string; version: number } }
    ).task;
    const claimed = (await run(worker, 'chorus.claim', {
      session_id: sid,
      task_id: task.id,
      expected_version: task.version,
    })) as {
      version: number;
      fence: number;
    };
    const submitted = (await run(worker, 'chorus.submit_result', {
      session_id: sid,
      task_id: task.id,
      expected_version: claimed.version,
      fence: claimed.fence,
      content: 'done',
      content_type: 'text/plain',
      criteria_mapping: [{ criterion: 0, note: 'ok' }],
    })) as { version: number; content_sha256: string };
    const requested = (await run(worker, 'chorus.request_review', {
      session_id: sid,
      task_id: task.id,
      expected_version: submitted.version,
      revision: 1,
      reviewer_actor_id: reviewer.id,
    })) as { review: { id: string; version: number } };
    const verdict = (await run(reviewer, 'chorus.review', {
      session_id: sid,
      review_id: requested.review.id,
      expected_version: requested.review.version,
      verdict: 'approved',
      content_sha256: submitted.content_sha256,
    })) as { task: { state: string } };
    expect(verdict.task.state).toBe('done');
    const listed = (await run(owner, 'chorus.list_work', { session_id: sid })) as {
      items: { id: string; state: string }[];
    };
    expect(listed.items).toEqual([expect.objectContaining({ id: task.id, state: 'done' })]);
    expect(new Set(traces).size).toBe(traces.length);
    await audit.flush();
    expect(audit.failures()).toBe(0);
  });
});
