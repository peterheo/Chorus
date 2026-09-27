import { randomUUID } from 'node:crypto';
import { MCP_INSTRUCTIONS_BILLING } from '../../src/instructions.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CreditTransfer, LedgerClient } from '@chorus/sharednet-ledger';
import { createFakeLedgerClient, sampleTransfer } from '@chorus/sharednet-ledger/testing';
import {
  SEAT_MEMBER,
  SEAT_PRINCIPAL,
  SHAREDNET_ROOM,
  startStack,
  type Stack,
} from '../helpers/stack.ts';

interface Called {
  isError: boolean;
  data: Record<string, unknown>;
  structured: { error?: { code?: string; details?: Record<string, unknown> } } | undefined;
}

async function connect(s: Stack, token: string): Promise<Client> {
  const client = new Client({ name: 'chorus-arena-e2e', version: '1.0.0' });
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
    structuredContent?: Called['structured'];
  };
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  return {
    isError: result.isError === true,
    data: JSON.parse(text) as Record<string, unknown>,
    structured: result.structuredContent,
  };
}

describe('Arena over /mcp: the real SDK client against the app with billing enabled and a fake SharedNet ledger', () => {
  const transfers: CreditTransfer[] = [];
  let ledgerCalls = 0;
  const ledger: LedgerClient = {
    listTransfers: (args, signal) => {
      ledgerCalls++;
      return createFakeLedgerClient(transfers).listTransfers(args, signal);
    },
  };
  let s: Stack;
  let client: Client;
  let seat: string;
  let token: string;
  beforeAll(async () => {
    s = await startStack({ billing: 'enabled', ledger });
    const agent = s.agent('buyer');
    seat = agent.memberId;
    token = (await s.enroll(agent)).token;
    client = await connect(s, token);
  });
  afterAll(async () => {
    await client.close().catch(() => undefined);
    await s.stop();
  });

  const paymentFor = (quote: Record<string, unknown>): CreditTransfer => {
    const transfer = sampleTransfer({
      id: `txn_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      to_principal_id: SEAT_PRINCIPAL,
      addressed_to: SEAT_MEMBER,
      by_instance_id: seat,
      room_id: SHAREDNET_ROOM,
      amount: quote['amount'] as number,
      memo: quote['memo'] as string,
      created_at: new Date().toISOString(),
    });
    transfers.push(transfer);
    return transfer;
  };

  it('quote → pay → deliver → replay for create_action_board and create_tasks; the free create tools are not offered', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    // Room-level tools are offered to any room member; create_tasks appears once they belong to a session.
    for (const name of ['chorus.room_pulse', 'chorus.create_action_board']) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain('chorus.create_tasks');
    expect(names).not.toContain('chorus.create_session');
    // The instructions a billing-on server sends never point at the unregistered free create tools.
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS_BILLING);
    expect(names).not.toContain('chorus.create_task');

    // The buyer creates an action board: first a quote…
    const boardArgs = { request_id: 'e2e-board', session_name: 'Arena', board_name: 'Board' };
    const quote = await call(client, 'chorus.create_action_board', boardArgs);
    expect(quote).toMatchObject({ isError: true, data: { code: 'payment_required' } });
    // The whole quote reaches the agent, in the text body and in structuredContent.error.
    expect(quote.structured?.error?.code).toBe('payment_required');
    expect(quote.structured?.error?.details).toEqual(quote.data['details']);
    const details = (quote.data['details'] ?? {}) as Record<string, unknown>;
    expect(details).toMatchObject({
      state: 'PAYMENT_REQUIRED',
      amount: 8,
      pay_from_seat: seat,
      room_id: SHAREDNET_ROOM,
      payee: { member_id: SEAT_MEMBER, principal_id: SEAT_PRINCIPAL },
    });
    // …then the payment (made in SharedNet with the buyer's own seat), then delivery.
    const paid = paymentFor(details);
    const delivered = await call(client, 'chorus.create_action_board', {
      ...boardArgs,
      payment_txn_id: paid.id,
    });
    expect(delivered).toMatchObject({
      isError: false,
      data: { state: 'DELIVERED', amount: 8, txn_id: paid.id },
    });
    const created = (delivered.data['result'] ?? {}) as {
      session: { id: string };
      board: { id: string };
    };

    // The new session is real and usable: create_tasks quotes 1 credit per task.
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('chorus.create_tasks');
    const taskArgs = {
      request_id: 'e2e-tasks',
      session_id: created.session.id,
      board_id: created.board.id,
      tasks: [
        { title: 'First', acceptance_criteria: ['a'] },
        { title: 'Second', acceptance_criteria: ['b'] },
      ],
    };
    const taskQuote = await call(client, 'chorus.create_tasks', taskArgs);
    expect(taskQuote.data['code']).toBe('payment_required');
    const taskDetails = (taskQuote.data['details'] ?? {}) as Record<string, unknown>;
    expect(taskDetails['amount']).toBe(2);
    const taskPaid = paymentFor(taskDetails);
    const tasksDone = await call(client, 'chorus.create_tasks', {
      ...taskArgs,
      payment_txn_id: taskPaid.id,
    });
    expect(tasksDone).toMatchObject({ isError: false, data: { state: 'DELIVERED', amount: 2 } });
    const listed = await call(client, 'chorus.list_work', { session_id: created.session.id });
    expect((listed.data['items'] as unknown[]).length).toBe(2);

    // Replay: same request, no charge, no ledger call, no duplicate work.
    const calls = ledgerCalls;
    const again = await call(client, 'chorus.create_tasks', {
      ...taskArgs,
      payment_txn_id: taskPaid.id,
    });
    const { audit_trace_id: _a, ...first } = tasksDone.data;
    const { audit_trace_id: _b, ...second } = again.data;
    expect(again.isError).toBe(false);
    expect(second).toEqual(first);
    expect(ledgerCalls).toBe(calls);
    expect(
      (
        (await call(client, 'chorus.list_work', { session_id: created.session.id })).data[
          'items'
        ] as unknown[]
      ).length,
    ).toBe(2);

    // A changed request under the same request_id is refused, and the free pulse stays free.
    const changed = await call(client, 'chorus.create_tasks', {
      ...taskArgs,
      tasks: [{ title: 'Different', acceptance_criteria: ['z'] }],
    });
    expect(changed.data['code']).toBe('request_conflict');
    const pulse = await call(client, 'chorus.room_pulse', {});
    expect(pulse).toMatchObject({
      isError: false,
      data: { coverage: 'chorus_state_and_stored_conversation_suggestions' },
    });
    expect(
      await s.owner<{ n: string }>(`SELECT count(*) AS n FROM purchases WHERE state = 'delivered'`),
    ).toEqual([{ n: '2' }]);
  });
});
