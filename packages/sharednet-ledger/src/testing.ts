import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { LedgerUnavailableError } from './index.ts';
import type { CreditTransfer, LedgerClient, LedgerPage } from './index.ts';

export function sampleTransfer(overrides: Partial<CreditTransfer> = {}): CreditTransfer {
  return {
    id: 'txn_GBpzWGoB3a',
    from_principal_id: 'p_IGcqBAHTrB',
    to_principal_id: 'p_J6MlkeT8k1',
    amount: 1,
    memo: 'chorus:v1:test:0a3ef77c-aa71-4327-8b71-7d37b69fee30',
    room_id: 'rom_9HSOHqg20Z',
    by_instance_id: 'i_Gvf8qUNx92',
    addressed_to: 'i_ovRvzoqpv3',
    code: null,
    created_at: '2026-09-26T23:16:33.824Z',
    ...overrides,
  };
}

export function createFakeLedgerClient(
  transfers: CreditTransfer[],
  opts: { readonly pageFailures?: Map<number, LedgerUnavailableError['cause_code']> } = {},
): LedgerClient {
  const ordered = [...transfers].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  );
  let pageNumber = 0;

  return {
    listTransfers(args): Promise<LedgerPage> {
      pageNumber += 1;
      const failure = opts.pageFailures?.get(pageNumber);
      if (failure !== undefined) return Promise.reject(new LedgerUnavailableError(failure));
      const beforeIndex =
        args.before === undefined
          ? -1
          : ordered.findIndex((transfer) => transfer.id === args.before);
      const start =
        args.before === undefined ? 0 : beforeIndex === -1 ? ordered.length : beforeIndex + 1;
      const items = ordered.slice(start, start + args.limit);
      const hasMore = start + items.length < ordered.length;
      return Promise.resolve({
        items,
        next_cursor: hasMore ? (items.at(-1)?.id ?? null) : null,
        has_more: hasMore,
      });
    },
  };
}

function readRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://127.0.0.1');
}

function writeJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/** A transfer the fake server accepted: one per Idempotency-Key, however often it was posted. */
export interface FakePostedTransfer {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly body: unknown;
  readonly auth: string | null;
}

export async function startFakeLedgerServer(transfers: CreditTransfer[]): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly requests: { readonly path: string; readonly auth: string | null }[];
  readonly posted: FakePostedTransfer[];
}> {
  const ordered = [...transfers].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  );
  const requests: { path: string; auth: string | null }[] = [];
  const posted: FakePostedTransfer[] = [];
  const server: Server = createServer((request, response) => {
    const url = readRequestUrl(request);
    requests.push({
      path: `${url.pathname}${url.search}`,
      auth: request.headers.authorization ?? null,
    });
    if (url.pathname !== '/api/v1/credits/transfers') {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      request.on('end', () => {
        const key = request.headers['idempotency-key'];
        const idempotencyKey = typeof key === 'string' ? key : '';
        let transfer = posted.find((p) => p.idempotencyKey === idempotencyKey);
        if (transfer === undefined) {
          transfer = {
            id: `txn_Fake${String(posted.length + 1).padStart(6, '0')}`,
            idempotencyKey,
            body: JSON.parse(raw) as unknown,
            auth: request.headers.authorization ?? null,
          };
          posted.push(transfer);
        }
        response.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ transfer: { id: transfer.id }, purse: { balance: 0 } }));
      });
      return;
    }
    const limit = Number(url.searchParams.get('limit'));
    const before = url.searchParams.get('before');
    const beforeIndex =
      before === null ? -1 : ordered.findIndex((transfer) => transfer.id === before);
    const start = before === null ? 0 : beforeIndex === -1 ? ordered.length : beforeIndex + 1;
    const items = ordered.slice(start, start + limit);
    const hasMore = start + items.length < ordered.length;
    writeJson(response, {
      items,
      next_cursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      has_more: hasMore,
    });
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
    throw new Error('Fake ledger server did not bind a TCP port.');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    posted,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
