import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHttpLedgerClient, verifyPayment } from '../../src/index.ts';
import { sampleTransfer, startFakeLedgerServer } from '../../src/testing.ts';

describe('SharedNet ledger HTTP client', () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it('sends the expected path, pagination and seat authorization', async () => {
    const server = await startFakeLedgerServer([sampleTransfer()]);
    closeServer = server.close;
    const client = createHttpLedgerClient({ baseUrl: server.url, token: 'sni_TESTSECRET123' });
    await client.listTransfers({ limit: 25 }, new AbortController().signal);
    await client.listTransfers(
      { limit: 25, before: 'txn_Before123' },
      new AbortController().signal,
    );
    expect(server.requests).toEqual([
      {
        path: '/api/v1/credits/transfers?limit=25',
        auth: 'Bearer sni_TESTSECRET123',
      },
      {
        path: '/api/v1/credits/transfers?limit=25&before=txn_Before123',
        auth: 'Bearer sni_TESTSECRET123',
      },
    ]);
  });

  it('sends a transfer from the seat with the Idempotency-Key, and reads back its id', async () => {
    const server = await startFakeLedgerServer([]);
    closeServer = server.close;
    const client = createHttpLedgerClient({ baseUrl: server.url, token: 'sni_TESTSECRET123' });
    const request = {
      to: 'i_Buyer12345',
      amount: 3,
      memo: 'chorus:v1:refund:x',
      roomId: 'rom_Room12345',
      idempotencyKey: '0f8fad5b-d9cb-469f-a165-70867728950e',
    };
    const first = await client.transfer?.(request, new AbortController().signal);
    const again = await client.transfer?.(request, new AbortController().signal);
    expect(first?.id).toMatch(/^txn_/);
    expect(again).toEqual(first);
    expect(server.posted).toEqual([
      {
        id: first?.id,
        idempotencyKey: request.idempotencyKey,
        auth: 'Bearer sni_TESTSECRET123',
        body: {
          to: 'i_Buyer12345',
          amount: 3,
          memo: 'chorus:v1:refund:x',
          room_id: 'rom_Room12345',
        },
      },
    ]);
  });

  it('refuses a transfer without a UUID idempotency key before sending anything', async () => {
    const client = createHttpLedgerClient({ baseUrl: 'http://127.0.0.1:1', token: 'token' });
    await expect(
      client.transfer?.(
        { to: 'i_x', amount: 1, memo: 'm', roomId: 'rom_x', idempotencyKey: 'not-a-uuid' },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('turns an aborted request into a timeout error', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createHttpLedgerClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 'token',
      timeoutMs: 1000,
    });
    await expect(client.listTransfers({ limit: 1 }, controller.signal)).rejects.toMatchObject({
      cause_code: 'timeout',
    });
  });

  it('fails closed when the server returns a malformed next cursor', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          items: [sampleTransfer({ id: 'txn_other123' })],
          next_cursor: 'abc',
          has_more: true,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      throw new Error('Malformed-cursor test server did not bind a TCP port.');
    }
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    const client = createHttpLedgerClient({
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      token: 'token',
    });
    await expect(
      verifyPayment(client, {
        txnId: 'txn_GBpzWGoB3a',
        payeePrincipalId: 'p_J6MlkeT8k1',
        payeeMemberId: 'i_ovRvzoqpv3',
        requesterMemberId: 'i_Gvf8qUNx92',
        roomId: 'rom_9HSOHqg20Z',
        amount: 1,
        memo: 'chorus:v1:test:0a3ef77c-aa71-4327-8b71-7d37b69fee30',
        quoteCreatedAt: new Date('2026-09-26T23:16:33.824Z'),
      }),
    ).resolves.toEqual({ status: 'unavailable', cause: 'contract_mismatch' });
  });

  it('returns null cursors at the end and empty pages for unknown cursors', async () => {
    const server = await startFakeLedgerServer([sampleTransfer()]);
    closeServer = server.close;
    const client = createHttpLedgerClient({ baseUrl: server.url, token: 'token' });
    await expect(
      client.listTransfers({ limit: 1 }, new AbortController().signal),
    ).resolves.toMatchObject({ next_cursor: null, has_more: false });
    await expect(
      client.listTransfers({ limit: 1, before: 'txn_unknown123' }, new AbortController().signal),
    ).resolves.toEqual({ items: [], next_cursor: null, has_more: false });
  });

  it('maps a delayed server response to timeout and a closed server to network', async () => {
    const delayed = createServer((_request, response) => {
      const timer = setTimeout(() => {
        response.end(JSON.stringify({ items: [], next_cursor: null, has_more: false }));
      }, 50);
      response.on('close', () => {
        clearTimeout(timer);
      });
    });
    await new Promise<void>((resolve, reject) => {
      delayed.once('error', reject);
      delayed.listen(0, '127.0.0.1', () => {
        delayed.off('error', reject);
        resolve();
      });
    });
    const address = delayed.address();
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve, reject) => {
        delayed.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      throw new Error('Delayed test server did not bind a TCP port.');
    }
    const url = `http://127.0.0.1:${String(address.port)}`;
    const client = createHttpLedgerClient({ baseUrl: url, token: 'token', timeoutMs: 10 });
    await expect(
      client.listTransfers({ limit: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ cause_code: 'timeout' });
    await new Promise<void>((resolve, reject) => {
      delayed.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await expect(
      client.listTransfers({ limit: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ cause_code: 'network' });
  });
});
