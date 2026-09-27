import { ChorusError } from '@chorus/domain';
import { describe, expect, it, vi } from 'vitest';
import { fetchConversationWindow } from '../../src/conversation/fetch.js';

const token = 'sni_secret_token_for_leak_checks_123';
const message = (sequence: number, type = 'message') => ({
  id: `msg_${String(sequence)}`,
  sequence,
  sender_principal_id: 'p_ABCDEF12',
  sender: { member_id: 'i_ABCDEF12', name: 'Member' },
  type,
  content: `body ${String(sequence)}`,
  reply_to_message_id: null,
});
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A fake fetch that answers every call with `next()`. */
const answering = (next: () => Response): typeof fetch =>
  vi.fn<typeof fetch>(() => Promise.resolve(next()));
/** A fake fetch that never answers and rejects with `reason` once the request is aborted. */
const hanging = (reason: Error): typeof fetch =>
  vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(reason);
          },
          { once: true },
        );
      }),
  );
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const args = (fetchImpl: typeof fetch, fromSequence = 10, toSequence = 20) => ({
  sharednetBaseUrl: 'https://sharednet.example',
  externalRoomId: 'rom_ABC123',
  seatToken: token,
  fromSequence,
  toSequence,
  fetchImpl,
});
const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('fetchConversationWindow', () => {
  it('CC6: requests ascending pages and returns only in-window messages', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      calls.push({ url: urlOf(input), init });
      return Promise.resolve(
        calls.length === 1
          ? response({
              items: [message(9), message(10), message(15, 'reaction')],
              has_more: true,
              next_cursor: 15,
            })
          : response({ items: [message(16), message(21)], has_more: true, next_cursor: 21 }),
      );
    });

    const result = await fetchConversationWindow(args(fetchImpl));

    const [first, second] = calls;
    if (first === undefined || second === undefined) throw new Error('expected two page requests');
    expect(new URL(first.url).searchParams.get('after')).toBe('9');
    expect(new URL(first.url).searchParams.get('limit')).toBe('100');
    expect(new URL(first.url).searchParams.get('order')).toBe('asc');
    expect(new URL(second.url).searchParams.get('after')).toBe('15');
    expect(first.init?.signal).toBe(second.init?.signal);
    expect(result.messages.map((item) => item.sequence)).toEqual([10, 16]);
    // The cutoff is the highest IN-WINDOW sequence examined (the reaction at 15 counts, 21 is past the window).
    expect(result.cutoffSequence).toBe(16);
  });

  it('accepts a null or missing sender name and shows the member id instead', async () => {
    const unnamed = { ...message(11), sender: { member_id: 'i_UNNAMED1', name: null } };
    const nameless = { ...message(12), sender: { member_id: 'i_NONAME12' } };
    const fetchImpl = answering(() =>
      response({ items: [message(10), unnamed, nameless], has_more: false, next_cursor: 12 }),
    );

    const result = await fetchConversationWindow(args(fetchImpl));

    expect(result.messages.map((item) => item.sender_name)).toEqual([
      'Member',
      'i_UNNAMED1',
      'i_NONAME12',
    ]);
  });

  it('still rejects a sender name that is neither a string nor null', async () => {
    const bad = { ...message(10), sender: { member_id: 'i_ABCDEF12', name: 42 } };
    const fetchImpl = answering(() => response({ items: [bad], has_more: false, next_cursor: 10 }));

    const error = await failureOf(fetchConversationWindow(args(fetchImpl)));

    expect(error).toBeInstanceOf(ChorusError);
    expect((error as ChorusError).details).toMatchObject({ cause: 'contract_mismatch' });
  });

  it('never reports a cutoff beyond the window, and from - 1 when nothing in it was examined', async () => {
    const busy = await fetchConversationWindow(
      args(
        answering(() =>
          response({ items: [message(12), message(40)], has_more: false, next_cursor: null }),
        ),
        10,
        20,
      ),
    );
    expect(busy.cutoffSequence).toBe(12);
    const empty = await fetchConversationWindow(
      args(
        answering(() => response({ items: [message(30)], has_more: false, next_cursor: null })),
        10,
        20,
      ),
    );
    expect(empty.messages).toEqual([]);
    expect(empty.cutoffSequence).toBe(9);
  });

  it('rejects windows of 200 or more sequence steps', async () => {
    await expect(
      fetchConversationWindow(args(vi.fn<typeof fetch>(), 1, 201)),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('CC7: maps HTTP failures, timeouts, malformed contracts and sparse windows to fixed errors', async () => {
    let sparsePage = 0;
    const cases: { fetchImpl: typeof fetch; timeoutMs?: number; cause: string }[] = [
      { fetchImpl: answering(() => response({}, 503)), cause: 'http_503' },
      { fetchImpl: hanging(new Error('aborted')), timeoutMs: 5, cause: 'timeout' },
      {
        fetchImpl: answering(() => response({ items: [{}], has_more: false, next_cursor: null })),
        cause: 'contract_mismatch',
      },
      {
        fetchImpl: answering(() => {
          sparsePage += 1;
          return response({
            items: [message(sparsePage)],
            has_more: true,
            next_cursor: sparsePage,
          });
        }),
        cause: 'window_too_sparse',
      },
    ];
    for (const testCase of cases) {
      const err = await failureOf(
        fetchConversationWindow({
          ...args(testCase.fetchImpl, 1, 190),
          ...(testCase.timeoutMs === undefined ? {} : { timeoutMs: testCase.timeoutMs }),
        }),
      );
      expect(err).toBeInstanceOf(ChorusError);
      expect(err).toMatchObject({
        code: 'temporarily_unavailable',
        details: { cause: testCase.cause },
      });
    }
  });

  it('never includes the seat token or request query in failure messages or details', async () => {
    let sparsePage = 0;
    const failures: (typeof fetch)[] = [
      vi.fn<typeof fetch>(() => Promise.reject(new Error(token))),
      answering(() => response({}, 401)),
      answering(() => response({}, 503)),
      hanging(new Error(token)),
      answering(() => response({ items: [{}], has_more: false, next_cursor: null })),
      answering(() => {
        sparsePage += 1;
        return response({ items: [message(sparsePage)], has_more: true, next_cursor: sparsePage });
      }),
    ];
    for (const [index, fetchImpl] of failures.entries()) {
      const err = await failureOf(
        fetchConversationWindow({
          ...args(fetchImpl, 1, 190),
          ...(index === 3 ? { timeoutMs: 5 } : {}),
        }),
      );
      if (!(err instanceof ChorusError)) throw new Error('expected a ChorusError');
      const errorText = `${err.message} ${JSON.stringify(err.details)}`;
      expect(errorText).not.toContain(token);
      expect(errorText).not.toContain('after=');
      expect(errorText).not.toContain('limit=');
    }
  });
});
