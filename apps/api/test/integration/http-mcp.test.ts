import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AUDIT_MAX_EVENTS } from '../../src/audit-read.ts';
import { MCP_INSTRUCTIONS } from '../../src/instructions.ts';
import { openSecret } from '../../src/secrets.ts';
import { startStack, type Enrolled, type Stack } from '../helpers/stack.ts';

interface Called {
  isError: boolean;
  data: Record<string, unknown>;
}

const MARK = `MARK-${randomUUID()}`;

/** A real MCP SDK client (Streamable HTTP transport) authenticated with one Chorus token. */
async function connect(s: Stack, token: string): Promise<Client> {
  const client = new Client({ name: 'chorus-test', version: '1.0.0' });
  // The SDK's transport types predate `exactOptionalPropertyTypes` (its `sessionId?` is not `| undefined`).
  const transport = new StreamableHTTPClientTransport(new URL(`${s.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }) as unknown as Transport;
  await client.connect(transport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Called> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  return { isError: result.isError === true, data: JSON.parse(text) as Record<string, unknown> };
}
const write = (client: Client, name: string, args: Record<string, unknown>) =>
  call(client, name, { idempotency_key: randomUUID(), ...args });
const ok = (r: Called): Record<string, unknown> => {
  expect(r.isError, JSON.stringify(r.data)).toBe(false);
  return r.data;
};

describe('e2e.fake_sharednet.lifecycle: activate, enroll four seats, sessions, the task flow (real MCP SDK client)', () => {
  let s: Stack;
  let clients: Client[] = [];
  beforeAll(async () => {
    s = await startStack({ activateViaApi: true });
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await s.stop();
  });

  it('C1 + S17: the whole flow, a hidden second session, and tools/list shows only chorus.*', async () => {
    const [ea, eb, ec, ed] = (await Promise.all(
      ['alice', 'bob', 'carol', 'dave'].map((n) => s.enroll(s.agent(n))),
    )) as [Enrolled, Enrolled, Enrolled, Enrolled];
    const [a, b, c, d] = (await Promise.all([ea, eb, ec, ed].map((e) => connect(s, e.token)))) as [
      Client,
      Client,
      Client,
      Client,
    ];
    clients = [a, b, c, d];

    const listed = await a.listTools();
    expect(listed.tools.length).toBeGreaterThan(0);
    expect(listed.tools.every((t) => t.name.startsWith('chorus.'))).toBe(true);
    expect(a.getInstructions() ?? '').toBe(MCP_INSTRUCTIONS);

    const who = ok(await call(a, 'chorus.whoami'));
    expect(who).toMatchObject({
      actor_id: ea.actorId,
      display_name: 'alice',
      instance_id: ea.instanceId,
      room: { id: ea.roomId, sharednet_room_id: 'rom_TestRoom01' },
      lease_duration_seconds: 900,
      server_commit: 'abc1234',
    });
    expect(typeof who['audit_trace_id']).toBe('string');

    // A creates the working session and a hidden, listed-only one that D must never see.
    const s1 = ok(
      await write(a, 'chorus.create_session', { name: 'Work', board_name: 'Board' }),
    ) as {
      session: { id: string };
      board: { id: string };
    };
    const hidden = ok(
      await write(a, 'chorus.create_session', {
        name: 'Hidden',
        board_name: 'B',
        discoverable: false,
        join_policy: 'listed',
        listed_principals: [],
      }),
    ) as { session: { id: string } };
    ok(await write(b, 'chorus.join_session', { session_id: s1.session.id }));
    ok(await write(c, 'chorus.join_session', { session_id: s1.session.id }));

    const sid = s1.session.id;
    const task = (
      ok(
        await write(a, 'chorus.create_task', {
          session_id: sid,
          board_id: s1.board.id,
          title: 'Ship it',
          acceptance_criteria: ['Works'],
        }),
      ) as { task: { id: string; version: number } }
    ).task;
    const claimed = ok(
      await write(b, 'chorus.claim', {
        session_id: sid,
        task_id: task.id,
        expected_version: task.version,
      }),
    ) as { version: number; fence: number };
    const submitted = ok(
      await write(b, 'chorus.submit_result', {
        session_id: sid,
        task_id: task.id,
        expected_version: claimed.version,
        fence: claimed.fence,
        content: `result ${MARK}`,
        content_type: 'text/plain',
        criteria_mapping: [{ criterion: 0, note: `note ${MARK}` }],
      }),
    ) as { version: number; content_sha256: string };
    const members = ok(await call(b, 'chorus.list_members', { session_id: sid })) as {
      items: { actor_id: string }[];
    };
    expect(members.items.map((m) => m.actor_id)).toEqual(
      expect.arrayContaining([ea.actorId, eb.actorId, ec.actorId]),
    );
    const requested = ok(
      await write(b, 'chorus.request_review', {
        session_id: sid,
        task_id: task.id,
        expected_version: submitted.version,
        revision: 1,
        reviewer_actor_id: ec.actorId,
      }),
    ) as { review: { id: string; version: number } };
    const mine = ok(await call(c, 'chorus.list_my_reviews', { session_id: sid })) as {
      items: { id: string }[];
    };
    expect(mine.items.map((r) => r.id)).toContain(requested.review.id);
    ok(await call(c, 'chorus.get_result', { session_id: sid, task_id: task.id, revision: 1 }));
    const verdict = ok(
      await write(c, 'chorus.review', {
        session_id: sid,
        review_id: requested.review.id,
        expected_version: requested.review.version,
        verdict: 'approved',
        content_sha256: submitted.content_sha256,
        notes: `looks good ${MARK}`,
      }),
    ) as { task: { state: string } };
    expect(verdict.task.state).toBe('done'); // auto-complete on approval

    // D is a room member but not in any session: no sessions, no access, and the hidden one does not exist to D.
    const visible = ok(await call(d, 'chorus.list_sessions')) as { items: { id: string }[] };
    expect(visible.items.map((x) => x.id)).not.toContain(hidden.session.id);
    const attempt = await write(d, 'chorus.join_session', { session_id: hidden.session.id });
    expect(attempt).toMatchObject({ isError: true, data: { code: 'not_found' } });
    const denied = await call(d, 'chorus.get_task', { session_id: sid, task_id: task.id });
    expect(denied.isError).toBe(true);

    // C14 log redaction (captured during C1): no token, seat token, invite, content or notes in any log line.
    const logText = s.logs.join('');
    for (const secret of [
      ea.token,
      eb.token,
      ec.token,
      ed.token,
      s.seatToken,
      MARK,
      'rit_TestInvite',
    ]) {
      expect(logText, secret).not.toContain(secret);
    }
    const access = s.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['msg'] === 'request');
    expect(access.length).toBeGreaterThan(10);
    for (const line of access) {
      expect(
        Object.keys(line).filter((k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k)),
      ).toEqual(expect.arrayContaining(['request_id', 'method', 'path', 'status', 'duration_ms']));
      const allowed = new Set([
        'level',
        'time',
        'pid',
        'hostname',
        'msg',
        'reqId',
        'request_id',
        'method',
        'path',
        'status',
        'duration_ms',
        'actor_id',
        'tool',
      ]);
      expect(
        Object.keys(line).filter((k) => !allowed.has(k)),
        JSON.stringify(line),
      ).toEqual([]);
    }
    expect(access.some((l) => l['tool'] === 'chorus.create_task')).toBe(true);
  });
});

describe('http: transport, bearer matrix, audit read and ops (real PostgreSQL, fake SharedNet)', () => {
  let s: Stack;
  let a: Enrolled;
  let b: Enrolled;
  beforeAll(async () => {
    s = await startStack({ limits: { mcpPerTokenPerMinute: 1000 } });
    a = await s.enroll(s.agent('ann'));
    b = await s.enroll(s.agent('ben'));
  });
  afterAll(async () => {
    await s.stop();
  });

  const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
    fetch(`${s.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw ?? JSON.stringify(body),
    });
  const auth = (e: Enrolled) => ({ authorization: `Bearer ${e.token}` });
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    },
  };

  it('C6 mcp.transport.json_only: 200 application/json, 202 empty, 405 with Allow, batch 400, 413', async () => {
    const init = await post(initialize, auth(a));
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toContain('application/json');
    expect(init.headers.get('x-request-id')).toBeTruthy();
    expect(await init.json()).toMatchObject({ result: { serverInfo: { name: 'chorus' } } });

    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, auth(a));
    expect(note.status).toBe(202);
    expect(await note.text()).toBe('');

    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(`${s.baseUrl}/mcp`, { method, headers: auth(a) });
      expect(r.status, method).toBe(405);
      expect(r.headers.get('allow')).toBe('POST');
    }
    const batch = await post([initialize], auth(a));
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ error: 'invalid_request', status: 400 });
    const notJson = await post(undefined, auth(a), '{nope');
    expect(notJson.status).toBe(400);
    const big = await post(
      undefined,
      auth(a),
      JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 10) }),
    );
    expect(big.status).toBe(413);
  });

  it('C7 http.auth.bearer: missing, malformed, unknown, expired, revoked, grant revoked and suspended room are all 401 before any MCP work', async () => {
    const challenge = (r: Response) => {
      expect(r.headers.get('www-authenticate')).toBe('Bearer realm="chorus"');
    };
    // Even a body that cannot be parsed gets the 401 first: authentication precedes everything.
    for (const headers of [
      {},
      { authorization: 'Bearer nope' },
      { authorization: `Bearer cht_${'A'.repeat(43)}` },
    ]) {
      const r = await post(undefined, headers, '{nope');
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ error: 'unauthenticated', status: 401 });
      challenge(r);
    }
    const c = await s.enroll(s.agent('cat'));
    expect((await post(initialize, auth(c))).status).toBe(200);
    await s.owner(
      `UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE actor_id = $1`,
      [c.actorId],
    );
    expect((await post(initialize, auth(c))).status).toBe(401);

    const d = await s.enroll(s.agent('dan'));
    await s.owner(`UPDATE api_tokens SET revoked_at = now() WHERE actor_id = $1`, [d.actorId]);
    expect((await post(initialize, auth(d))).status).toBe(401);

    const e = await s.enroll(s.agent('eve'));
    expect((await post(initialize, auth(e))).status).toBe(200);
    await s.owner(`UPDATE room_members SET removed_at = now() WHERE actor_id = $1`, [e.actorId]);
    expect((await post(initialize, auth(e))).status).toBe(401);

    const f = await s.enroll(s.agent('fay'));
    expect((await post(initialize, auth(f))).status).toBe(200);
    await s.owner(`UPDATE rooms SET activation_state = 'suspended' WHERE id = $1`, [s.roomId]);
    try {
      expect((await post(initialize, auth(f))).status).toBe(401);
      expect((await post(initialize, auth(a))).status).toBe(401);
    } finally {
      await s.owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [s.roomId]);
    }
    expect((await post(initialize, auth(a))).status).toBe(200);
  });

  it('4.1-5 audit read: only the caller’s own events, or events of sessions the caller is a live member of', async () => {
    const ca = await connect(s, a.token);
    const cb = await connect(s, b.token);
    try {
      const created = ok(
        await write(ca, 'chorus.create_session', { name: 'Audited', board_name: 'B' }),
      ) as {
        session: { id: string };
        audit_trace_id: string;
      };
      const sid = created.session.id;
      const read = ok(await call(ca, 'chorus.get_session', { session_id: sid })) as {
        audit_trace_id: string;
      };
      const trace = read.audit_trace_id;
      const audit = (token: string | undefined, query = `?trace=${trace}`) =>
        fetch(`${s.baseUrl}/v1/audit${query}`, {
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        });
      const eventsFor = async (token: string) => {
        let last: unknown[] = [];
        await s.waitFor('audit events written', async () => {
          const r = await audit(token);
          last = ((await r.json()) as { events: unknown[] }).events;
          return last.length > 0;
        });
        return last;
      };
      expect((await eventsFor(a.token)).length).toBeGreaterThan(0);
      const body = (await (await audit(a.token)).json()) as {
        trace_id: string;
        events: { traceId: string }[];
      };
      expect(body.trace_id).toBe(trace);
      expect(body.events.every((e) => e.traceId === trace)).toBe(true);

      // B is in the room but not in the session, and did not act: sees nothing of A's trace.
      expect(((await (await audit(b.token)).json()) as { events: unknown[] }).events).toEqual([]);
      // Once B is a live member of the session, the session's events become visible to B.
      ok(await write(cb, 'chorus.join_session', { session_id: sid }));
      expect(
        ((await (await audit(b.token)).json()) as { events: unknown[] }).events.length,
      ).toBeGreaterThan(0);

      expect((await audit(undefined)).status).toBe(401);
      expect((await audit(a.token, '')).status).toBe(400);
      expect((await audit(a.token, '?trace=x')).status).toBe(400);

      // Capped at 200, and another workspace's identical trace id is never returned.
      const capTrace = `cap-${randomUUID()}`;
      await s.owner(
        `INSERT INTO sharedos_audit_events (workspace_id, event)
         SELECT $1, jsonb_build_object('traceId', $2::text, 'actor', jsonb_build_object('kind', 'agent', 'agentId', $3::text))
           FROM generate_series(1, $4::int)`,
        [s.workspaceId, capTrace, a.actorId, AUDIT_MAX_EVENTS + 50],
      );
      const capped = (await (await audit(a.token, `?trace=${capTrace}`)).json()) as {
        events: unknown[];
      };
      expect(capped.events).toHaveLength(AUDIT_MAX_EVENTS);
    } finally {
      await ca.close();
      await cb.close();
    }
  });

  it('C14 http.ops: the /mcp rate limit is per token and answers 429 + Retry-After', async () => {
    const limited = await startStack({ limits: { mcpPerTokenPerMinute: 3 } });
    try {
      const x = await limited.enroll(limited.agent('rate'));
      const y = await limited.enroll(limited.agent('other'));
      const hit = (e: Enrolled) =>
        fetch(`${limited.baseUrl}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${e.token}` },
          body: JSON.stringify(initialize),
        });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await hit(x)).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      const refused = await hit(x);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await refused.json()).toMatchObject({ error: 'rate_limited', status: 429 });
      expect((await hit(y)).status).toBe(200); // another token is unaffected
    } finally {
      await limited.stop();
    }
  });
});

describe('C8 activate.self_serve: POST /v1/rooms/activate', () => {
  const INVITE = 'rit_SecondRoomInvite0123456789';
  const ROOM = 'rom_SecondRoom01';
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ limits: { activateGlobalPerMinute: 40 } });
  });
  afterAll(async () => {
    await s.stop();
  });

  const activate = (room: string, invite: string, extra: Record<string, unknown> = {}) =>
    fetch(`${s.baseUrl}/v1/rooms/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sharednet_room_id: room, sharednet_invite_token: invite, ...extra }),
    });
  const seatFor = (label: string) => ({
    token: `sni_${label}${randomUUID().replaceAll('-', '')}`,
    memberId: `i_${label}Seat01`,
    principalId: `p_${label}Seat01`,
  });
  const stored = (room: string) =>
    s.owner<{ id: string }>(`SELECT id FROM rooms WHERE external_room_id = $1`, [room]);

  it('creates a workspace, bound room, encrypted seat and cursor (no session) and is idempotent without joining again', async () => {
    const seat = seatFor('Second');
    s.fake.addInvite(ROOM, INVITE, seat);
    s.post(
      { memberId: 'i_someoneelse1', principalId: 'p_someoneelse1', name: 'x' },
      'history line',
    ); // (posted to the default room; the second room has its own, empty history)
    const created = await activate(ROOM, INVITE);
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, string>;
    expect(body).toMatchObject({
      status: 'active',
      sharednet_room_id: ROOM,
      next: 'http://127.0.0.1:0/v1/enroll/start',
    });
    const [room] = await s.owner<{
      id: string;
      workspace_id: string;
      activation_state: string;
      provider: string;
    }>(
      `SELECT id, workspace_id, activation_state, provider FROM rooms WHERE external_room_id = $1`,
      [ROOM],
    );
    // No internal id is exposed to the (unauthenticated) caller.
    expect(body).toEqual({
      status: 'active',
      sharednet_room_id: ROOM,
      next: 'http://127.0.0.1:0/v1/enroll/start',
    });
    expect(room).toMatchObject({ activation_state: 'active', provider: 'sharednet' });
    expect(room?.workspace_id).not.toBe(s.workspaceId); // a workspace per room
    expect(await s.owner(`SELECT 1 FROM sessions WHERE room_id = $1`, [room?.id])).toEqual([]);
    const [row] = await s.owner<{
      member_id: string;
      principal_id: string;
      token_ciphertext: Buffer;
      token_nonce: Buffer;
      key_id: string;
    }>(
      `SELECT member_id, principal_id, token_ciphertext, token_nonce, key_id FROM sharednet_seats WHERE room_id = $1`,
      [room?.id],
    );
    if (row === undefined) throw new Error('no seat row');
    expect(row).toMatchObject({ member_id: seat.memberId, principal_id: seat.principalId });
    expect(row.token_ciphertext.toString('utf8')).not.toContain(seat.token);
    expect(
      openSecret(s.secretsKey, {
        ciphertext: row.token_ciphertext,
        nonce: row.token_nonce,
        keyId: row.key_id,
      }),
    ).toBe(seat.token);
    expect(s.fake.joins.filter((j) => j.roomId === ROOM)).toEqual([
      { roomId: ROOM, bodyName: 'chorus', runtimeKind: 'chorus-service' },
    ]);

    // Idempotent: 200 already_active with the same room, and the invite is NOT used again.
    const again = await activate(ROOM, INVITE);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      status: 'already_active',
      sharednet_room_id: ROOM,
      next: 'http://127.0.0.1:0/v1/enroll/start',
    });
    expect(s.fake.joins.filter((j) => j.roomId === ROOM)).toHaveLength(1);

    // The invite and the member token are in no log line and in no table column in the clear.
    const logs = s.logs.join('');
    for (const secret of [INVITE, seat.token]) expect(logs).not.toContain(secret);
    const dump = await s.owner<{ t: string }>(
      `SELECT (SELECT coalesce(string_agg(x::text, ''), '') FROM rooms x) || (SELECT coalesce(string_agg(x::text, ''), '') FROM workspaces x) || (SELECT coalesce(string_agg(x::text, ''), '') FROM sharednet_cursors x) AS t`,
    );
    for (const secret of [INVITE, seat.token]) expect(dump[0]?.t).not.toContain(secret);
  });

  it('refuses a bad invite (422 activation_failed), malformed bodies (400) and stores nothing', async () => {
    const before = (await s.owner(`SELECT 1 FROM rooms`)).length;
    const bad = await activate('rom_NoSuchRoom01', 'rit_BogusInvite0123456789ab');
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: 'activation_failed', status: 422 });
    for (const body of [
      { sharednet_room_id: 'nope', sharednet_invite_token: INVITE },
      { sharednet_room_id: ROOM, sharednet_invite_token: 'nope' },
      { sharednet_room_id: ROOM },
    ]) {
      const r = await fetch(`${s.baseUrl}/v1/rooms/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
    }
    expect((await activate(ROOM, INVITE, { extra: 1 })).status).toBe(400);
    expect((await s.owner(`SELECT 1 FROM rooms`)).length).toBe(before);
  });

  it('fails closed on contract violations (404 room_not_available), SharedNet outages (503) and a suspended room (422)', async () => {
    const seat = seatFor('Broken');
    const room = 'rom_BrokenRoom01';
    const invite = 'rit_BrokenInvite0123456789ab';
    s.fake.addInvite(room, invite, seat);
    const before = (await s.owner(`SELECT 1 FROM rooms`)).length;
    const tampered: [string, () => void][] = [
      ['no member_token', () => (s.fake.joinResponse = (b) => ({ ...b, member_token: undefined }))],
      [
        'bad history',
        () => (s.fake.joinResponse = (b) => ({ ...b, history: { items: [{ sequence: 'x' }] } })),
      ],
      [
        'principal mismatch',
        () => (s.fake.instanceResponse = (b) => ({ ...b, principal: { id: 'p_Different01' } })),
      ],
      [
        'revoked instance',
        () =>
          (s.fake.instanceResponse = (b) => ({
            ...b,
            instance: { ...(b['instance'] as object), revoked_at: '2026-01-01T00:00:00Z' },
          })),
      ],
      [
        'bad instance id',
        () =>
          (s.fake.instanceResponse = (b) => ({
            ...b,
            instance: { ...(b['instance'] as object), id: 'nope' },
          })),
      ],
    ];
    for (const [label, tamper] of tampered) {
      s.fake.joinResponse = undefined;
      s.fake.instanceResponse = undefined;
      tamper();
      const r = await activate(room, invite);
      expect(r.status, label).toBe(404);
      expect(await r.json(), label).toMatchObject({ error: 'room_not_available' });
    }
    s.fake.joinResponse = undefined;
    s.fake.instanceResponse = undefined;
    s.fake.joinFailWith = 500;
    expect((await activate(room, invite)).status).toBe(503);
    s.fake.joinFailWith = undefined;
    expect((await s.owner(`SELECT 1 FROM rooms`)).length).toBe(before);

    // A bound room that is not active is refused (only the operator path reactivates).
    const okRes = await activate(room, invite);
    expect(okRes.status).toBe(201);
    await s.owner(`UPDATE rooms SET activation_state = 'suspended' WHERE external_room_id = $1`, [
      room,
    ]);
    const refused = await activate(room, invite);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: 'activation_failed' });
  });

  it('serializes concurrent activations of one room: exactly one 201, one workspace', async () => {
    const seat = seatFor('Race');
    const room = 'rom_RaceRoom0001';
    const invite = 'rit_RaceInvite01234567890ab';
    s.fake.addInvite(room, invite, seat);
    const results = await Promise.all(Array.from({ length: 6 }, () => activate(room, invite)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 201)).toHaveLength(1);
    expect(statuses.filter((x) => x === 200)).toHaveLength(5);
    expect(await stored(room)).toHaveLength(1);
    expect(
      await s.owner(
        `SELECT 1 FROM sharednet_seats se JOIN rooms r ON r.id = se.room_id WHERE r.external_room_id = $1`,
        [room],
      ),
    ).toHaveLength(1);
  });

  it('is rate limited globally (429 + Retry-After)', async () => {
    const limited = await startStack({ limits: { activateGlobalPerMinute: 2 } });
    try {
      const hit = () =>
        fetch(`${limited.baseUrl}/v1/rooms/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sharednet_room_id: 'rom_NoSuchRoom01',
            sharednet_invite_token: 'rit_BogusInvite0123456789ab',
          }),
        });
      expect([(await hit()).status, (await hit()).status]).toEqual([422, 422]);
      const refused = await hit();
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await limited.stop();
    }
  });
});
