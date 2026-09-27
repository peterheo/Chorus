import { describe, expect, it, vi } from 'vitest';
import {
  createHttpLedgerClient,
  verifyPayment,
  type CreditTransfer,
  type LedgerClient,
} from '../../src/index.ts';
import { createFakeLedgerClient, sampleTransfer } from '../../src/testing.ts';

const quoteCreatedAt = new Date('2026-09-26T23:16:33.824Z');
const expectation = {
  txnId: 'txn_GBpzWGoB3a',
  payeePrincipalId: 'p_J6MlkeT8k1',
  payeeMemberId: 'i_ovRvzoqpv3',
  requesterMemberId: 'i_Gvf8qUNx92',
  roomId: 'rom_9HSOHqg20Z',
  amount: 1,
  memo: 'chorus:v1:test:0a3ef77c-aa71-4327-8b71-7d37b69fee30',
  quoteCreatedAt,
};

describe('ledger HTTP contract validation', () => {
  it('rejects every missing or mistyped field and accepts unknown fields', async () => {
    const transfer = sampleTransfer();
    const nullableFields = ['memo', 'room_id', 'by_instance_id', 'code'] as const;
    const requiredStrings = [
      'id',
      'from_principal_id',
      'to_principal_id',
      'addressed_to',
      'created_at',
    ] as const;
    const variants: Record<string, unknown>[] = [];
    for (const field of [...requiredStrings, 'amount', ...nullableFields]) {
      const missing = Object.fromEntries(Object.entries(transfer).filter(([key]) => key !== field));
      variants.push(missing);
      variants.push({ ...transfer, [field]: field === 'amount' ? 'eight' : 7 });
    }
    variants.push({ ...transfer, amount: 0 });
    variants.push({ ...transfer, amount: 1.5 });
    variants.push({ ...transfer, created_at: 'yesterday' });

    for (const item of variants) {
      const client = createHttpLedgerClient({
        baseUrl: 'https://www.sharednet.ai',
        token: 'sni_TESTSECRET123',
        fetchImpl: vi.fn(() =>
          Promise.resolve(Response.json({ items: [item], next_cursor: null, has_more: false })),
        ),
      });
      await expect(
        client.listTransfers({ limit: 10 }, new AbortController().signal),
      ).rejects.toMatchObject({
        cause_code: 'contract_mismatch',
      });
    }

    const client = createHttpLedgerClient({
      baseUrl: 'https://www.sharednet.ai',
      token: 'token',
      fetchImpl: vi.fn(() =>
        Promise.resolve(
          Response.json({
            items: [{ ...transfer, future_field: true }],
            next_cursor: null,
            has_more: false,
          }),
        ),
      ),
    });
    await expect(
      client.listTransfers({ limit: 10 }, new AbortController().signal),
    ).resolves.toMatchObject({
      items: [transfer],
    });
  });

  it('rejects invalid pagination arguments before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createHttpLedgerClient({
      baseUrl: 'https://www.sharednet.ai',
      token: 'token',
      fetchImpl,
    });
    for (const limit of [0, 101]) {
      await expect(
        client.listTransfers({ limit }, new AbortController().signal),
      ).rejects.toBeInstanceOf(RangeError);
    }
    await expect(
      client.listTransfers({ limit: 10, before: 'bad' }, new AbortController().signal),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('payment verification', () => {
  it.each([
    ['payee', { to_principal_id: 'p_wrong123' }],
    ['payee', { addressed_to: 'i_wrong123' }],
    ['payer_seat', { by_instance_id: null }],
    ['payer_seat', { by_instance_id: 'i_other123' }],
    ['room', { room_id: null }],
    ['room', { room_id: 'rom_other123' }],
    ['amount', { amount: 7 }],
    ['amount', { amount: 9 }],
    ['memo', { memo: `${expectation.memo} ` }],
    ['age', { created_at: '2026-09-26T23:15:33.823Z' }],
  ] as const)('returns the first failed check: %s', async (reason, changes) => {
    const client = createFakeLedgerClient([sampleTransfer(changes)]);
    await expect(verifyPayment(client, expectation)).resolves.toMatchObject({
      status: 'not_verified',
      reason,
    });
  });

  it('checks payer seat before memo', async () => {
    const client = createFakeLedgerClient([
      sampleTransfer({ by_instance_id: 'i_other123', memo: 'wrong' }),
    ]);
    await expect(verifyPayment(client, expectation)).resolves.toMatchObject({
      status: 'not_verified',
      reason: 'payer_seat',
    });
  });

  it('finds a transfer on page 4', async () => {
    const transfers = [
      sampleTransfer({ id: 'txn_newest1', created_at: '2026-09-26T23:19:00.000Z' }),
      sampleTransfer({ id: 'txn_newest2', created_at: '2026-09-26T23:18:00.000Z' }),
      sampleTransfer({ id: 'txn_newest3', created_at: '2026-09-26T23:17:00.000Z' }),
      sampleTransfer(),
    ];
    const client = createFakeLedgerClient(transfers);
    await expect(
      verifyPayment(client, expectation, { pageSize: 1, maxPages: 5 }),
    ).resolves.toMatchObject({
      status: 'verified',
    });
  });

  it.each([
    ['next_cursor', 'txn_cursor123'],
    ['last item id', null],
  ] as const)('uses %s as the next-page cursor', async (_label, cursor) => {
    const calls: { readonly limit: number; readonly before?: string }[] = [];
    const client: LedgerClient = {
      listTransfers(args): Promise<{
        readonly items: readonly CreditTransfer[];
        readonly next_cursor: string | null;
        readonly has_more: boolean;
      }> {
        calls.push(args);
        if (calls.length === 1) {
          return Promise.resolve({
            items: [sampleTransfer({ id: 'txn_pageone1' })],
            next_cursor: cursor,
            has_more: true,
          });
        }
        return Promise.resolve({ items: [sampleTransfer()], next_cursor: null, has_more: false });
      },
    };
    await expect(verifyPayment(client, expectation, { pageSize: 1 })).resolves.toMatchObject({
      status: 'verified',
    });
    expect(calls).toEqual([{ limit: 1 }, { limit: 1, before: cursor ?? 'txn_pageone1' }]);
  });

  it('caps scanning and stops at the age boundary', async () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      sampleTransfer({
        id: `txn_newest${String(index)}`,
        created_at: new Date(quoteCreatedAt.getTime() + (7 - index) * 1000).toISOString(),
      }),
    );
    const bounded = createFakeLedgerClient(items);
    await expect(
      verifyPayment(bounded, expectation, { pageSize: 1, maxPages: 5 }),
    ).resolves.toEqual({
      status: 'not_found',
      pagesScanned: 5,
    });

    const aged = createFakeLedgerClient([
      sampleTransfer({ id: 'txn_recent1', created_at: '2026-09-26T23:16:33.824Z' }),
      sampleTransfer({ id: 'txn_older123', created_at: '2026-09-26T23:15:33.000Z' }),
      sampleTransfer({ id: expectation.txnId, created_at: '2026-09-26T23:15:00.000Z' }),
    ]);
    await expect(verifyPayment(aged, expectation, { pageSize: 1 })).resolves.toEqual({
      status: 'not_found',
      pagesScanned: 2,
    });
  });

  it('returns unavailable for a page failure and throws on invalid expectations', async () => {
    const failing = createFakeLedgerClient(
      [
        sampleTransfer({ id: 'txn_newest1', created_at: '2026-09-26T23:17:30.000Z' }),
        sampleTransfer({ id: 'txn_newest2', created_at: '2026-09-26T23:17:20.000Z' }),
      ],
      { pageFailures: new Map([[2, 'timeout']]) },
    );
    await expect(verifyPayment(failing, expectation, { pageSize: 1 })).resolves.toEqual({
      status: 'unavailable',
      cause: 'timeout',
    });
    await expect(
      verifyPayment(createFakeLedgerClient([]), { ...expectation, amount: 0 }),
    ).rejects.toThrow(TypeError);
    await expect(
      verifyPayment(createFakeLedgerClient([]), {
        ...expectation,
        quoteCreatedAt: new Date(Number.NaN),
      }),
    ).rejects.toThrow(TypeError);
  });

  it('throws RangeError when pagination bounds are outside the accepted ranges', async () => {
    const client = createFakeLedgerClient([]);
    for (const options of [{ maxPages: 0 }, { maxPages: 21 }, { pageSize: 0 }, { pageSize: 101 }]) {
      await expect(verifyPayment(client, expectation, options)).rejects.toThrow(RangeError);
    }
  });

  it('returns a null cursor at the end and an empty page for an unknown cursor', async () => {
    const client = createFakeLedgerClient([sampleTransfer()]);
    const signal = new AbortController().signal;
    await expect(client.listTransfers({ limit: 1 }, signal)).resolves.toEqual({
      items: [sampleTransfer()],
      next_cursor: null,
      has_more: false,
    });
    await expect(
      client.listTransfers({ limit: 1, before: 'txn_unknown123' }, signal),
    ).resolves.toEqual({ items: [], next_cursor: null, has_more: false });
  });

  it('exports a fixture with the live contract field types', () => {
    const transfer: CreditTransfer = sampleTransfer();
    expect(transfer).toEqual({
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
    });
  });

  it('rejects amounts one credit below or above the expectation', async () => {
    await expect(
      verifyPayment(createFakeLedgerClient([sampleTransfer({ amount: 1 })]), {
        ...expectation,
        amount: 2,
      }),
    ).resolves.toMatchObject({ status: 'not_verified', reason: 'amount' });
    await expect(
      verifyPayment(createFakeLedgerClient([sampleTransfer({ amount: 2 })]), expectation),
    ).resolves.toMatchObject({ status: 'not_verified', reason: 'amount' });
  });

  it('maps HTTP and network failures without leaking credentials', async () => {
    const token = 'sni_TESTSECRET123';
    const errorClient = (fetchImpl: typeof fetch) =>
      createHttpLedgerClient({ baseUrl: 'https://www.sharednet.ai', token, fetchImpl });
    const signal = new AbortController().signal;
    const limited = errorClient(vi.fn(() => Promise.resolve(new Response(null, { status: 429 }))));
    await expect(limited.listTransfers({ limit: 1 }, signal)).rejects.toMatchObject({
      cause_code: 'rate_limited',
    });
    await expect(limited.listTransfers({ limit: 1 }, signal)).rejects.not.toThrow(token);
    const serverError = errorClient(
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );
    await expect(serverError.listTransfers({ limit: 1 }, signal)).rejects.toMatchObject({
      cause_code: 'http_status',
      http_status: 500,
    });
    await expect(serverError.listTransfers({ limit: 1 }, signal)).rejects.not.toThrow(token);
    const offline = errorClient(vi.fn(() => Promise.reject(new Error(token))));
    await expect(offline.listTransfers({ limit: 1 }, signal)).rejects.toMatchObject({
      cause_code: 'network',
    });
    await expect(offline.listTransfers({ limit: 1 }, signal)).rejects.not.toThrow(token);
  });

  it('maps a request that outlives timeoutMs to timeout', async () => {
    const client = createHttpLedgerClient({
      baseUrl: 'https://www.sharednet.ai',
      token: 'sni_TESTSECRET123',
      timeoutMs: 1,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const requestSignal = init?.signal;
          if (requestSignal === undefined || requestSignal === null) {
            reject(new Error('Request signal missing.'));
            return;
          }
          requestSignal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Request timed out.', 'AbortError'));
            },
            { once: true },
          );
        }),
    });
    await expect(
      client.listTransfers({ limit: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ cause_code: 'timeout' });
    await expect(
      client.listTransfers({ limit: 1 }, new AbortController().signal),
    ).rejects.not.toThrow('sni_TESTSECRET123');
  });

  it('conforms to the client interface', () => {
    const client: LedgerClient = createFakeLedgerClient([]);
    expect(client).toHaveProperty('listTransfers');
  });
});
