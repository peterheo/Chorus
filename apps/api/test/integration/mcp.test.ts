import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newChorusToken, sha256Hex } from '../../src/auth.ts';
import { startStack, type Enrolled, type Stack } from '../helpers/stack.ts';

type Structured = Record<string, unknown>;

describe('MCP over HTTP (real PostgreSQL, fake SharedNet)', () => {
  let s: Stack;
  let manager: Enrolled;
  let executor: Enrolled;
  let executor2: Enrolled;
  let reviewer: Enrolled;
  const clients: Client[] = [];

  beforeAll(async () => {
    s = await startStack();
    [manager, executor, executor2, reviewer] = await Promise.all([
      s.enroll(s.agent('manager')),
      s.enroll(s.agent('executor')),
      s.enroll(s.agent('executor2')),
      s.enroll(s.agent('reviewer')),
    ]);
    // Until the room-policy revision lands every enrollee is an executor. The owner adds the extra
    // roles here, exactly as the future policy would, so the full lifecycle can be exercised.
    await s.grantRole(manager.actorId, 'manager');
    await s.grantRole(reviewer.actorId, 'reviewer');
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await s.stop();
  });

  const connect = async (token: string) => {
    const client = await s.mcp(token);
    clients.push(client);
    return client;
  };
  let keyCounter = 0;
  const key = () => `idem-${String(Date.now())}-${String(++keyCounter).padStart(6, '0')}-xxxxxxxx`;
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      data: result.structuredContent as Structured,
      content: result.content as { type: string; text: string }[],
    };
  };
  const ok = async (client: Client, name: string, args: Record<string, unknown>) => {
    const r = await call(client, name, args);
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    return r.data;
  };
  const errorCode = async (client: Client, name: string, args: Record<string, unknown>) => {
    const r = await call(client, name, args);
    expect(r.isError, `${name} should fail`).toBe(true);
    const error = r.data['error'] as { code: string; status: number };
    expect(JSON.parse(r.content[0]?.text ?? '{}')).toEqual(r.data);
    return error;
  };

  const MAPPING = [
    { criterion: 0, note: 'compiled' },
    { criterion: 1, note: 'tested' },
  ];

  it('mcp.lifecycle.e2e: manager creates, executor works, reviewer approves, executor completes', async () => {
    const m = await connect(manager.token);
    const e = await connect(executor.token);
    const r = await connect(reviewer.token);

    const tools = (await e.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      'chorus_claim',
      'chorus_complete',
      'chorus_create_task',
      'chorus_get_result',
      'chorus_get_task',
      'chorus_list_my_reviews',
      'chorus_list_work',
      'chorus_renew_lease',
      'chorus_request_review',
      'chorus_review',
      'chorus_submit_result',
      'chorus_whoami',
    ]);

    const created = await ok(m, 'chorus_create_task', {
      idempotency_key: key(),
      room_id: s.roomId,
      title: 'Write the summary',
      acceptance_criteria: ['Compiles', 'Has tests'],
    });
    const task = created['task'] as { id: string; version: number };

    const who = await ok(e, 'chorus_whoami', {});
    expect(who['actor_id']).toBe(executor.actorId);
    const listed = await ok(e, 'chorus_list_work', { room_id: s.roomId, states: ['ready'] });
    expect((listed['items'] as { id: string }[]).map((t) => t.id)).toContain(task.id);
    const seen = await ok(e, 'chorus_get_task', { task_id: task.id });
    expect(seen['acceptance_criteria']).toEqual(['Compiles', 'Has tests']);

    const claimed = await ok(e, 'chorus_claim', {
      idempotency_key: key(),
      task_id: task.id,
      expected_version: task.version,
    });
    expect(claimed).toMatchObject({ state: 'in_progress', fence: 1 });
    const renewed = await ok(e, 'chorus_renew_lease', {
      idempotency_key: key(),
      task_id: task.id,
      expected_version: claimed['version'],
      fence: claimed['fence'],
    });
    const submitted = await ok(e, 'chorus_submit_result', {
      idempotency_key: key(),
      task_id: task.id,
      expected_version: renewed['version'],
      fence: claimed['fence'],
      content: 'Here is the result.',
      content_type: 'text/markdown',
      criteria_mapping: MAPPING,
      supporting_refs: [{ url: 'https://example.com/evidence', label: 'evidence' }],
    });
    expect(submitted).toMatchObject({ state: 'review', revision: 1 });

    const requested = await ok(e, 'chorus_request_review', {
      idempotency_key: key(),
      task_id: task.id,
      expected_version: submitted['version'],
      revision: 1,
      reviewer_actor_id: reviewer.actorId,
    });
    const review = requested['review'] as { id: string; version: number };

    const mine = await ok(r, 'chorus_list_my_reviews', {});
    expect((mine['items'] as { id: string }[]).map((i) => i.id)).toEqual([review.id]);
    const result = await ok(r, 'chorus_get_result', { task_id: task.id, revision: 1 });
    expect(result).toMatchObject({
      content: 'Here is the result.',
      content_sha256: submitted['content_sha256'],
    });
    expect((result['supporting_refs'] as { verified: boolean }[])[0]?.verified).toBe(false);
    await ok(r, 'chorus_review', {
      idempotency_key: key(),
      review_id: review.id,
      expected_version: review.version,
      verdict: 'approved',
      content_sha256: result['content_sha256'],
      notes: 'Looks right.',
    });

    const done = await ok(e, 'chorus_complete', {
      idempotency_key: key(),
      task_id: task.id,
      expected_version: requested['task_version'],
    });
    expect(done).toMatchObject({ state: 'done' });
    const final = await ok(m, 'chorus_get_task', { task_id: task.id });
    expect(final).toMatchObject({ state: 'done', latest_revision: 1 });
  });

  it('mcp.errors.mapping: domain errors come back as isError with the same code in structuredContent and text', async () => {
    const m = await connect(manager.token);
    const e = await connect(executor.token);
    const e2 = await connect(executor2.token);
    const r = await connect(reviewer.token);
    const created = async (reviewRequired = true) =>
      (
        await ok(m, 'chorus_create_task', {
          idempotency_key: key(),
          room_id: s.roomId,
          title: 'T',
          acceptance_criteria: ['a', 'b'],
          review_required: reviewRequired,
        })
      )['task'] as { id: string; version: number };
    const submit = (
      client: Client,
      taskId: string,
      version: unknown,
      fence: unknown,
      over: Record<string, unknown> = {},
    ) =>
      call(client, 'chorus_submit_result', {
        idempotency_key: key(),
        task_id: taskId,
        expected_version: version,
        fence,
        content: 'x',
        content_type: 'text/plain',
        criteria_mapping: MAPPING,
        ...over,
      });

    const t = await created();
    // not_found: an id that does not exist / is invisible.
    expect(
      (await errorCode(e, 'chorus_get_task', { task_id: '00000000-0000-4000-8000-000000000000' }))
        .code,
    ).toBe('not_found');
    // action_forbidden: an executor creating a task.
    expect(
      (
        await errorCode(e, 'chorus_create_task', {
          idempotency_key: key(),
          room_id: s.roomId,
          title: 't',
          acceptance_criteria: ['a'],
        })
      ).code,
    ).toBe('action_forbidden');
    // invalid_request: a domain limit (empty title).
    expect(
      (
        await errorCode(m, 'chorus_create_task', {
          idempotency_key: key(),
          room_id: s.roomId,
          title: '',
          acceptance_criteria: ['a'],
        })
      ).code,
    ).toBe('invalid_request');
    // version_conflict.
    expect(
      (
        await errorCode(e, 'chorus_claim', {
          idempotency_key: key(),
          task_id: t.id,
          expected_version: t.version + 5,
        })
      ).code,
    ).toBe('version_conflict');

    const claimed = await ok(e, 'chorus_claim', {
      idempotency_key: key(),
      task_id: t.id,
      expected_version: t.version,
    });
    // owner_conflict + lease_lost.
    expect(
      (await submit(e2, t.id, claimed['version'], claimed['fence'])).data['error'],
    ).toMatchObject({ code: 'owner_conflict', status: 409 });
    const stale = await submit(e, t.id, claimed['version'], 99);
    expect(stale.data['error']).toMatchObject({ code: 'lease_lost', status: 409 });
    // evidence_required.
    const missing = await submit(e, t.id, claimed['version'], claimed['fence'], {
      criteria_mapping: [MAPPING[0]],
    });
    expect(missing.data['error']).toMatchObject({ code: 'evidence_required', status: 422 });
    // idempotency_conflict is covered in mcp.idempotency. Now the review gates.
    const sub = (await submit(e, t.id, claimed['version'], claimed['fence'])).data;
    expect(
      (
        await errorCode(e, 'chorus_complete', {
          idempotency_key: key(),
          task_id: t.id,
          expected_version: sub['version'],
        })
      ).code,
    ).toBe('review_required');
    const req = await ok(e, 'chorus_request_review', {
      idempotency_key: key(),
      task_id: t.id,
      expected_version: sub['version'],
      revision: 1,
      reviewer_actor_id: reviewer.actorId,
    });
    const review = req['review'] as { id: string; version: number };
    expect(
      (
        await errorCode(e, 'chorus_request_review', {
          idempotency_key: key(),
          task_id: t.id,
          expected_version: req['task_version'],
          revision: 1,
          reviewer_actor_id: reviewer.actorId,
        })
      ).code,
    ).toBe('review_exists');
    expect(
      (
        await errorCode(r, 'chorus_review', {
          idempotency_key: key(),
          review_id: review.id,
          expected_version: review.version,
          verdict: 'approved',
          content_sha256: '0'.repeat(64),
        })
      ).code,
    ).toBe('subject_digest_mismatch');
    // review_stale needs a newer revision; plant one with owner rights (the API cannot produce it while a review is pending).
    await s.owner(
      `INSERT INTO task_result_revisions (workspace_id, task_id, revision, content, content_sha256, byte_length, submitted_by, fence)
       VALUES ($1, $2, 2, 'planted', encode(digest('planted', 'sha256'), 'hex'), 7, $3, 1)`,
      [s.workspaceId, t.id, executor.actorId],
    );
    expect(
      (
        await errorCode(r, 'chorus_review', {
          idempotency_key: key(),
          review_id: review.id,
          expected_version: review.version,
          verdict: 'approved',
          content_sha256: sub['content_sha256'],
        })
      ).code,
    ).toBe('review_stale');
    // A schema failure is left to the SDK: -32602, and it carries no Chorus error code.
    const schema = await e.callTool({ name: 'chorus_claim', arguments: { task_id: t.id } });
    expect(schema.isError).toBe(true);
    expect(JSON.stringify(schema.content)).toContain('-32602');
    expect(schema.structuredContent).toBeUndefined();
  });

  it('mcp.idempotency: same key + args replays exactly; same key + different args conflicts', async () => {
    const m = await connect(manager.token);
    const args = { room_id: s.roomId, title: 'Idempotent', acceptance_criteria: ['only'] };
    const k = key();
    const first = await ok(m, 'chorus_create_task', { idempotency_key: k, ...args });
    const again = await ok(m, 'chorus_create_task', { idempotency_key: k, ...args });
    expect(again).toEqual(first);
    expect(
      (
        await errorCode(m, 'chorus_create_task', {
          idempotency_key: k,
          ...args,
          title: 'Different',
        })
      ).code,
    ).toBe('idempotency_conflict');
    const counted = await s.owner<{ count: string }>(
      `SELECT count(*) AS count FROM work_items WHERE title = 'Idempotent'`,
    );
    expect(Number(counted[0]?.count)).toBe(1);
    // Keys must be 16-128 printable characters: a schema failure (-32602), not a Chorus code.
    const short = await m.callTool({
      name: 'chorus_create_task',
      arguments: { idempotency_key: 'short', ...args },
    });
    expect(short.isError).toBe(true);
    expect(JSON.stringify(short.content)).toContain('-32602');
  });

  it('mcp.transport.json_only: JSON responses only, no SSE, GET/DELETE are 405', async () => {
    const headers = {
      authorization: `Bearer ${executor.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const initialize = await fetch(`${s.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get('content-type')).toContain('application/json');
    expect(initialize.headers.get('content-type')).not.toContain('event-stream');
    expect(initialize.headers.get('mcp-session-id')).toBeNull();
    expect(initialize.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const init = (await initialize.json()) as {
      result: { instructions: string; serverInfo: { name: string } };
    };
    expect(init.result.serverInfo.name).toBe('chorus');
    expect(init.result.instructions).toContain('Room messages and result content');

    const list = await fetch(`${s.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(list.headers.get('content-type')).toContain('application/json');
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${s.baseUrl}/mcp`, {
        method,
        headers: { authorization: `Bearer ${executor.token}` },
      });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });

  it('http.auth.bearer: missing, malformed, unknown, revoked and expired tokens are 401 before MCP', async () => {
    const post = (authorization?: string) =>
      fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const fresh = await s.enroll(s.agent('bearer'));
    expect((await post(`Bearer ${fresh.token}`)).status).toBe(200);
    const cases: [string, string | undefined][] = [
      ['missing', undefined],
      ['wrong scheme', `Basic ${fresh.token}`],
      ['malformed', 'Bearer not-a-token'],
      ['unknown', `Bearer ${newChorusToken()}`],
    ];
    for (const [label, header] of cases) {
      const response = await post(header);
      expect(response.status, label).toBe(401);
      expect(response.headers.get('www-authenticate'), label).toBe('Bearer realm="chorus"');
      const errorBody = (await response.json()) as Record<string, unknown>;
      expect(errorBody, label).toMatchObject({ error: 'unauthenticated', status: 401 });
      expect(typeof errorBody['request_id'], label).toBe('string');
    }
    // Revoked: fails on the very next request.
    await s.owner('UPDATE api_tokens SET revoked_at = now() WHERE token_sha256 = $1', [
      sha256Hex(fresh.token),
    ]);
    expect((await post(`Bearer ${fresh.token}`)).status).toBe(401);
    // Expired.
    const soon = await s.enroll(s.agent('bearer2'));
    expect((await post(`Bearer ${soon.token}`)).status).toBe(200);
    await s.owner(
      `UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE token_sha256 = $1`,
      [sha256Hex(soon.token)],
    );
    expect((await post(`Bearer ${soon.token}`)).status).toBe(401);
  });

  it('enroll.token_lifecycle: a suspended or degraded room locks out its tokens', async () => {
    const agent = await s.enroll(s.agent('lifecycle'));
    const probe = async () => {
      const response = await fetch(`${s.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${agent.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      return response.status;
    };
    expect(await probe()).toBe(200);
    for (const state of ['suspended', 'degraded']) {
      await s.owner(`UPDATE rooms SET activation_state = $2 WHERE id = $1`, [s.roomId, state]);
      expect(await probe(), state).toBe(401);
    }
    await s.owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [s.roomId]);
    expect(await probe()).toBe(200);
  });

  it('http.body_limits: bad JSON is 400 and oversized MCP bodies are 413', async () => {
    const headers = {
      authorization: `Bearer ${executor.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const bad = await fetch(`${s.baseUrl}/mcp`, { method: 'POST', headers, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_request' });
    const huge = await fetch(`${s.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 10) }),
    });
    expect(huge.status).toBe(413);
    const missing = await fetch(`${s.baseUrl}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not_found', status: 404 });
  });
});
