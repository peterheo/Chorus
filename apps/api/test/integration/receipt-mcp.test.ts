import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { startStack, type Enrolled, type Stack } from '../helpers/stack.ts';

async function connect(stack: Stack, token: string): Promise<Client> {
  const client = new Client({ name: 'receipt-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(stack.baseUrl + '/mcp'), {
    requestInit: { headers: { authorization: 'Bearer ' + token } },
  }) as unknown as Transport;
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  const text = result.content.find((item) => item.type === 'text')?.text ?? '{}';
  const data = JSON.parse(text) as Record<string, unknown>;
  expect(result.isError, JSON.stringify(data)).toBe(false);
  return data;
}

const write = (client: Client, name: string, args: Record<string, unknown>) =>
  call(client, name, { idempotency_key: randomUUID(), ...args });

describe('receipt MCP to HTTP verification', () => {
  let stack: Stack;
  const key = generateKeyPairSync('ed25519').privateKey;
  let clients: Client[] = [];

  beforeAll(async () => {
    stack = await startStack({ activateViaApi: true, receiptKey: key });
  });
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await stack.stop();
  });

  it('verifies a reviewed task receipt returned by chorus.get_receipt, and rejects a changed field', async () => {
    const [a, b, c] = (await Promise.all(
      ['receipt-admin', 'receipt-submitter', 'receipt-reviewer'].map((label) =>
        stack.enroll(stack.agent(label)),
      ),
    )) as [Enrolled, Enrolled, Enrolled];
    const [admin, submitter, reviewer] = await Promise.all([
      connect(stack, a.token),
      connect(stack, b.token),
      connect(stack, c.token),
    ]);
    clients = [admin, submitter, reviewer];

    const created = await write(admin, 'chorus.create_session', {
      name: 'Receipt session',
      board_name: 'Receipt board',
    });
    const session = (created['session'] as { id: string }).id;
    const board = (created['board'] as { id: string }).id;
    await write(submitter, 'chorus.join_session', { session_id: session });
    await write(reviewer, 'chorus.join_session', { session_id: session });
    const taskOutput = await write(admin, 'chorus.create_task', {
      session_id: session,
      board_id: board,
      title: 'Verified receipt',
      acceptance_criteria: ['The result is reviewed'],
    });
    const task = createdTask(taskOutput);
    const claimed = await write(submitter, 'chorus.claim', {
      session_id: session,
      task_id: task.id,
      expected_version: task.version,
    });
    const submitted = await write(submitter, 'chorus.submit_result', {
      session_id: session,
      task_id: task.id,
      expected_version: claimed['version'],
      fence: claimed['fence'],
      content: 'Reviewed result',
      content_type: 'text/plain',
      criteria_mapping: [{ criterion: 0, note: 'Reviewed' }],
      supporting_refs: [{ url: 'https://ci.example/runs/42', label: 'CI run' }],
    });
    const requested = await write(submitter, 'chorus.request_review', {
      session_id: session,
      task_id: task.id,
      expected_version: submitted['version'],
      revision: 1,
      reviewer_actor_id: c.actorId,
    });
    const review = requested['review'] as { id: string; version: number };
    await write(reviewer, 'chorus.review', {
      session_id: session,
      review_id: review.id,
      expected_version: review.version,
      verdict: 'approved',
      content_sha256: submitted['content_sha256'],
      notes: 'Approved',
    });

    const toolOutput = await call(admin, 'chorus.get_receipt', {
      session_id: session,
      task_id: task.id,
    });
    const { audit_trace_id: _trace, verify_url: verifyUrl, ...envelope } = toolOutput;
    const verify = async (value: unknown) =>
      fetch(stack.baseUrl + '/v1/receipts/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    expect(await (await verify(envelope)).json()).toMatchObject({ valid: true });
    // The shareable link carries the same envelope; the test stack's public base URL is a placeholder.
    expect(typeof verifyUrl).toBe('string');
    const link = new URL(verifyUrl as string);
    const opened = await fetch(stack.baseUrl + link.pathname + link.search);
    expect(await opened.json()).toMatchObject({
      valid: true,
      receipt: envelope['receipt'],
    });
    const receipt = envelope['receipt'] as Record<string, unknown>;
    // The receipt says what it vouches for, and signs the submitter's evidence as submitted.
    expect(receipt['attests']).toBe('result_review');
    expect((receipt['result'] as Record<string, unknown>)['supporting_refs']).toEqual([
      { url: 'https://ci.example/runs/42', label: 'CI run' },
    ]);
    const changed = {
      ...envelope,
      receipt: {
        ...receipt,
        task: { ...(receipt['task'] as object), title: 'Changed' },
      },
    };
    expect(await (await verify(changed)).json()).toMatchObject({ valid: false });
  });
});

function createdTask(value: Record<string, unknown>): { id: string; version: number } {
  return value['task'] as { id: string; version: number };
}
