import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { startStack, type Stack } from '../helpers/stack.ts';

interface Raw {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: { status?: string; error?: Record<string, unknown> };
  _meta?: Record<string, unknown>;
}

async function connect(s: Stack, token: string): Promise<Client> {
  const client = new Client({ name: 'chorus-error-details', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${s.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }) as unknown as Transport;
  await client.connect(transport);
  return client;
}
const raw = async (client: Client, name: string, args: Record<string, unknown>): Promise<Raw> =>
  (await client.callTool({ name, arguments: args })) as Raw;
const body = (r: Raw): Record<string, unknown> =>
  JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? '{}') as Record<string, unknown>;
const write = (client: Client, name: string, args: Record<string, unknown>) =>
  raw(client, name, { idempotency_key: randomUUID(), ...args });

describe('MCP failures keep their details: text body and structuredContent.error (over /mcp, real SDK client)', () => {
  let s: Stack;
  let owner: Client;
  let outsider: Client;
  beforeAll(async () => {
    s = await startStack();
    owner = await connect(s, (await s.enroll(s.agent('owner'))).token);
    outsider = await connect(s, (await s.enroll(s.agent('outsider'))).token);
  });
  afterAll(async () => {
    await owner.close().catch(() => undefined);
    await outsider.close().catch(() => undefined);
    await s.stop();
  });

  const setup = async () => {
    const created = body(
      await write(owner, 'chorus.create_session', { name: 'S', board_name: 'B' }),
    ) as {
      session: { id: string };
      board: { id: string };
    };
    const task = (
      body(
        await write(owner, 'chorus.create_task', {
          session_id: created.session.id,
          board_id: created.board.id,
          title: 'T',
          acceptance_criteria: ['c'],
        }),
      ) as { task: { id: string; version: number } }
    ).task;
    return { session: created.session.id, task };
  };

  it('(a) version_conflict exposes details.current_version in the text body and in structuredContent.error', async () => {
    const { session, task } = await setup();
    const result = await write(owner, 'chorus.claim', {
      session_id: session,
      task_id: task.id,
      expected_version: task.version + 5,
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({
      status: 'failed',
      code: 'version_conflict',
      details: { current_version: task.version },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'failed',
      error: { code: 'version_conflict', details: { current_version: task.version } },
    });
    expect(result._meta).toEqual({
      'sharedos/status': 'failed',
      'sharedos/code': 'version_conflict',
    });
  });

  it('(b) a SharedOS denial has structuredContent.error.code and no details anywhere', async () => {
    const { session, task } = await setup();
    const result = await raw(outsider, 'chorus.get_task', {
      session_id: session,
      task_id: task.id,
    });
    expect(result.isError).toBe(true);
    const code = result.structuredContent?.error?.['code'];
    expect(['no_matching_grant', 'tool_unavailable']).toContain(code);
    expect(result.structuredContent?.status).toBe('denied');
    expect(result.structuredContent?.error).not.toHaveProperty('details');
    expect(body(result)).not.toHaveProperty('details');
    // Nothing of the call (arguments, ids, tokens) is copied into the error.
    const text = JSON.stringify(result);
    expect(text).not.toContain(session);
    expect(text).not.toContain(task.id);
  });

  it('(c) a failed CallToolResult keeps its exact shape (snapshot)', async () => {
    const { session, task } = await setup();
    const result = await write(owner, 'chorus.claim', {
      session_id: session,
      task_id: task.id,
      expected_version: task.version + 5,
    });
    // Ids are per run; everything else is pinned.
    const stable = JSON.parse(
      JSON.stringify(result).replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        '<uuid>',
      ),
    ) as unknown;
    expect(stable).toMatchSnapshot();
  });

  it('a successful result is unchanged: no structuredContent is added', async () => {
    const result = await raw(owner, 'chorus.whoami', {});
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toBeUndefined();
  });
});
