/**
 * Minimal SharedNet HTTP client: the one call the watcher needs (`GET /rooms/{id}/wait`).
 * Frozen contract (spec D3.7): messages carry a server-assigned `sender_principal_id` and
 * `sender.member_id`, and `sequence` is strictly increasing per room. Anything else is a contract
 * violation and the room fails closed (degraded), never processed on a guess.
 */
export interface SharedNetMessage {
  readonly id: string;
  readonly sequence: number;
  readonly senderPrincipalId: string;
  readonly senderMemberId: string;
  /** The SharedNet agent tag of the sender, when it has one (used only for `policy_matched` joins). */
  readonly senderAgentId: string | null;
  readonly content: string;
}

export interface WaitPage {
  readonly messages: readonly SharedNetMessage[];
  readonly hasMore: boolean;
}

export class SharedNetAuthError extends Error {
  override readonly name = 'SharedNetAuthError';
}
export class SharedNetContractError extends Error {
  override readonly name = 'SharedNetContractError';
}
export class SharedNetHttpError extends Error {
  override readonly name = 'SharedNetHttpError';
}

export interface SharedNetClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Client-side timeout for one long-poll (SharedNet holds it ~25 s). Default 35 s. */
  readonly timeoutMs?: number;
}

export class SharedNetClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SharedNetClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 35_000;
  }

  async wait(
    roomId: string,
    token: string,
    after: number,
    signal?: AbortSignal,
  ): Promise<WaitPage> {
    const url = `${this.baseUrl}/api/v1/rooms/${encodeURIComponent(roomId)}/wait?after=${String(after)}`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (response.status === 401 || response.status === 403) {
      throw new SharedNetAuthError(
        `SharedNet rejected the service seat (HTTP ${String(response.status)}).`,
      );
    }
    if (!response.ok) {
      throw new SharedNetHttpError(`SharedNet returned HTTP ${String(response.status)}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SharedNetContractError('SharedNet returned a non-JSON body.');
    }
    return parsePage(body, after);
  }
}

function fail(reason: string): never {
  throw new SharedNetContractError(`SharedNet contract violation: ${reason}`);
}

export function parsePage(body: unknown, after: number): WaitPage {
  if (body === null || typeof body !== 'object') fail('body is not an object');
  const page = body as Record<string, unknown>;
  const items = page['items'];
  if (!Array.isArray(items)) fail('items is not an array');
  const messages: SharedNetMessage[] = [];
  let previous = after;
  for (const raw of items as unknown[]) {
    if (raw === null || typeof raw !== 'object') fail('an item is not an object');
    const item = raw as Record<string, unknown>;
    const sender = item['sender'];
    const memberId =
      sender !== null && typeof sender === 'object'
        ? (sender as Record<string, unknown>)['member_id']
        : undefined;
    const id = item['id'];
    const sequence = item['sequence'];
    const principal = item['sender_principal_id'];
    const agentRaw = item['sender_agent_id'];
    const content = item['content'];
    if (typeof id !== 'string' || id === '') fail('an item lacks id');
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence))
      fail('an item lacks an integer sequence');
    if (typeof principal !== 'string' || !/^p_[A-Za-z0-9]{6,64}$/.test(principal))
      fail('an item lacks sender_principal_id');
    if (typeof memberId !== 'string' || !/^i_[A-Za-z0-9]{6,64}$/.test(memberId))
      fail('an item lacks sender.member_id');
    if (typeof content !== 'string') fail('an item lacks content');
    if (sequence <= previous) fail('sequence is not strictly increasing');
    previous = sequence;
    messages.push({
      id,
      sequence,
      senderPrincipalId: principal,
      senderMemberId: memberId,
      senderAgentId: typeof agentRaw === 'string' && agentRaw !== '' ? agentRaw : null,
      content,
    });
  }
  return { messages, hasMore: page['has_more'] === true };
}
