import { ChorusError, type SourceMessage } from '@chorus/domain';

export interface FetchWindowArgs {
  readonly sharednetBaseUrl: string;
  readonly externalRoomId: string;
  readonly seatToken: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface FetchedWindow {
  readonly messages: readonly SourceMessage[];
  readonly cutoffSequence: number;
}

const ERROR_MESSAGE = 'SharedNet conversation fetch failed.';
const invalid = () => new ChorusError('invalid_request', 'Invalid conversation fetch window.');
const unavailable = (cause: string): never => {
  throw new ChorusError('temporarily_unavailable', ERROR_MESSAGE, { details: { cause } });
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
type PageItem = SourceMessage & { readonly type: string };

function parsePage(value: unknown): readonly [PageItem[], boolean, string | number | null] {
  if (
    !isRecord(value) ||
    !Array.isArray(value['items']) ||
    typeof value['has_more'] !== 'boolean'
  ) {
    unavailable('contract_mismatch');
  }
  const page = value as Record<string, unknown>;
  const pageItems = page['items'] as unknown[];
  const cursor = page['next_cursor'];
  if (!(cursor === null || typeof cursor === 'string' || typeof cursor === 'number'))
    unavailable('contract_mismatch');
  const items: PageItem[] = [];
  let previous = 0;
  for (const raw of pageItems) {
    if (!isRecord(raw)) unavailable('contract_mismatch');
    const sender = raw['sender'];
    if (!isRecord(sender)) unavailable('contract_mismatch');
    const {
      id,
      sequence,
      sender_principal_id: principal,
      content,
      reply_to_message_id: reply,
    } = raw;
    const member = sender['member_id'];
    const name = sender['name'];
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence <= previous ||
      typeof member !== 'string' ||
      !member.startsWith('i_') ||
      typeof principal !== 'string' ||
      !principal.startsWith('p_') ||
      typeof name !== 'string' ||
      typeof content !== 'string' ||
      !(reply === null || typeof reply === 'string') ||
      typeof raw['type'] !== 'string'
    )
      unavailable('contract_mismatch');
    previous = sequence;
    items.push({
      message_id: id as string,
      sequence: sequence as number,
      sender_member_id: member as string,
      sender_principal_id: principal as string,
      sender_name: name as string,
      content: content as string,
      reply_to_message_id: reply as string | null,
      type: raw['type'] as string,
    });
  }
  return [items, page['has_more'] as boolean, cursor as string | number | null];
}

export async function fetchConversationWindow(args: FetchWindowArgs): Promise<FetchedWindow> {
  if (
    typeof args.sharednetBaseUrl !== 'string' ||
    !/^https?:\/\//.test(args.sharednetBaseUrl) ||
    args.sharednetBaseUrl.endsWith('/') ||
    typeof args.externalRoomId !== 'string' ||
    !args.externalRoomId.startsWith('rom_') ||
    typeof args.seatToken !== 'string' ||
    !Number.isSafeInteger(args.fromSequence) ||
    args.fromSequence < 1 ||
    !Number.isSafeInteger(args.toSequence) ||
    args.toSequence < args.fromSequence ||
    args.toSequence - args.fromSequence >= 200 ||
    (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1))
  )
    throw invalid();

  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 10_000);
  const messages: SourceMessage[] = [];
  let cutoffSequence = args.fromSequence - 1;
  let after: string | number = args.fromSequence - 1;
  try {
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      if (controller.signal.aborted) unavailable('timeout');
      const query = new URLSearchParams({ after: String(after), limit: '100', order: 'asc' });
      const url = `${args.sharednetBaseUrl}/api/v1/rooms/${encodeURIComponent(args.externalRoomId)}/messages?${query}`;
      const init: RequestInit = {
        method: 'GET',
        headers: { authorization: `Bearer ${args.seatToken}`, accept: 'application/json' },
        signal: controller.signal,
      };
      const response = await fetchImpl(url, init).catch(() =>
        unavailable(controller.signal.aborted ? 'timeout' : 'network'),
      );
      if (!response.ok) unavailable(`http_${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        unavailable(controller.signal.aborted ? 'timeout' : 'contract_mismatch');
      }
      if (controller.signal.aborted) unavailable('timeout');
      const [items, hasMore, nextCursor] = parsePage(body);
      for (const item of items) {
        cutoffSequence = Math.max(cutoffSequence, item.sequence);
        if (
          item.type === 'message' &&
          item.sequence >= args.fromSequence &&
          item.sequence <= args.toSequence
        ) {
          const { type: _type, ...message } = item;
          messages.push(message);
        }
      }
      const lastSequence = items.at(-1)?.sequence;
      if (!hasMore || lastSequence === undefined || lastSequence >= args.toSequence) break;
      if (nextCursor === null || nextCursor === after || nextCursor === undefined) {
        unavailable('contract_mismatch');
      }
      if (pageNumber === 2) unavailable('window_too_sparse');
      after = nextCursor as string | number;
    }
  } finally {
    clearTimeout(timer);
  }
  messages.sort((a, b) => a.sequence - b.sequence);
  return { messages, cutoffSequence };
}
