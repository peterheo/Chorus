import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHttpLedgerClient } from '../../src/index.ts';
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
