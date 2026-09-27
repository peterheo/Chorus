import { ChorusError } from '@chorus/domain';
import { describe, expect, it, vi } from 'vitest';
import { fetchConversationWindow } from '../../src/conversation/fetch.js';

const token = 'sni_secret_token_for_leak_checks_123';
const message = (sequence: number, type = 'message') => ({
  id: `msg_${sequence}`,
  sequence,
  sender_principal_id: 'p_ABCDEF12',
  sender: { member_id: 'i_ABCDEF12', name: 'Member' },
  type,
  content: `body ${sequence}`,
  reply_to_message_id: null,
});
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const args = (fetchImpl: typeof fetch, fromSequence = 10, toSequence = 20) => ({
  sharednetBaseUrl: 'https://sharednet.example',
  externalRoomId: 'rom_ABC123',
  seatToken: token,
  fromSequence,
  toSequence,
  fetchImpl,
});

describe('fetchConversationWindow', () => {
  it('CC6: requests ascending pages and returns only in-window messages', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return calls.length === 1
        ? response({
            items: [message(9), message(10), message(15, 'reaction')],
            has_more: true,
            next_cursor: 15,
          })
        : response({ items: [message(16), message(21)], has_more: true, next_cursor: 21 });
    });

    const result = await fetchConversationWindow(args(fetchImpl));

    expect(new URL(calls[0]!.url).searchParams.get('after')).toBe('9');
    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('100');
    expect(new URL(calls[0]!.url).searchParams.get('order')).toBe('asc');
    expect(new URL(calls[1]!.url).searchParams.get('after')).toBe('15');
    expect(calls[0]!.init?.signal).toBe(calls[1]!.init?.signal);
    expect(result.messages.map((item) => item.sequence)).toEqual([10, 16]);
    expect(result.cutoffSequence).toBe(21);
  });

  it('rejects windows of 200 or more sequence steps', async () => {
    await expect(
      fetchConversationWindow(args(vi.fn() as typeof fetch, 1, 201)),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('CC7: maps HTTP failures, timeouts, malformed contracts and sparse windows to fixed errors', async () => {
    let sparsePage = 0;
    const cases: Array<{ fetchImpl: typeof fetch; timeoutMs?: number; cause: string }> = [
      { fetchImpl: vi.fn(async () => response({}, 503)) as typeof fetch, cause: 'http_503' },
      {
        fetchImpl: vi.fn(
          (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
            }),
        ) as typeof fetch,
        timeoutMs: 5,
        cause: 'timeout',
      },
      {
        fetchImpl: vi.fn(async () =>
          response({ items: [{}], has_more: false, next_cursor: null }),
        ) as typeof fetch,
        cause: 'contract_mismatch',
      },
      {
        fetchImpl: vi.fn(async () => {
          sparsePage += 1;
          return response({
            items: [message(sparsePage)],
            has_more: true,
            next_cursor: sparsePage,
          });
        }) as typeof fetch,
        cause: 'window_too_sparse',
      },
    ];
    for (const testCase of cases) {
      const err = await fetchConversationWindow({
        ...args(testCase.fetchImpl, 1, 190),
        ...(testCase.timeoutMs === undefined ? {} : { timeoutMs: testCase.timeoutMs }),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(err).toBeInstanceOf(ChorusError);
      expect(err).toMatchObject({
        code: 'temporarily_unavailable',
        details: { cause: testCase.cause },
      });
    }
  });

  it('never includes the seat token or request query in failure messages or details', async () => {
    const failures: (typeof fetch)[] = [
      vi.fn(async () => {
        throw new Error(token);
      }) as typeof fetch,
      vi.fn(async () => response({}, 401)) as typeof fetch,
      vi.fn(async () =>
        response({ items: [{}], has_more: false, next_cursor: null }),
      ) as typeof fetch,
    ];
    for (const fetchImpl of failures) {
      const err = await fetchConversationWindow(args(fetchImpl)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(err).toBeInstanceOf(ChorusError);
      const errorText = `${(err as Error).message} ${JSON.stringify((err as ChorusError).details)}`;
      expect(errorText).not.toContain(token);
      expect(errorText).not.toContain('after=');
      expect(errorText).not.toContain('limit=');
    }
  });
});
