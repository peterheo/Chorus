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
  /** Optional fields the coordination follow uses (spec §10); absent or mistyped values read as unknown. */
  readonly senderName?: string;
  readonly replyToMessageId?: string | null;
  /** The item type (`message` for chat); absent on servers that do not send it. */
  readonly type?: string;
}

export interface WaitPage {
  readonly messages: readonly SharedNetMessage[];
  readonly hasMore: boolean;
}

export interface JoinResult {
  /** The seat's `sni_` token. Sensitive: sealed at rest, never logged. */
  readonly memberToken: string;
  /** The highest sequence in the join's history, or 0 when it is empty. */
  readonly lastSequence: number;
}

export interface SeatIdentity {
  /** `instance.id` (`i_…`): what the watcher matches `sender.member_id` against. */
  readonly memberId: string;
  readonly principalId: string;
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

  /**
   * Joins an existing room with an invite and returns the seat's member token plus the highest history
   * sequence (0 when empty). Only the documented fields are used; anything missing or mistyped is a contract
   * violation. 401/403/404 are `SharedNetAuthError` (the invite was refused); the invite is never echoed.
   */
  async join(roomId: string, inviteToken: string, signal?: AbortSignal): Promise<JoinResult> {
    const url = `${this.baseUrl}/api/v1/rooms/${encodeURIComponent(roomId)}/join`;
    const body = await this.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${inviteToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'chorus', runtime: { kind: 'chorus-service' } }),
      ...(signal === undefined ? {} : { signal }),
    });
    return parseJoin(body);
  }

  /** The identity of the seat that owns `memberToken` (`GET /api/v1/instances/current`). */
  async currentInstance(memberToken: string, signal?: AbortSignal): Promise<SeatIdentity> {
    const url = `${this.baseUrl}/api/v1/instances/current`;
    const body = await this.request(url, {
      headers: { authorization: `Bearer ${memberToken}`, accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
    return parseInstance(body);
  }

  /**
   * Posts `content` from the seat that owns `token` (`POST /api/v1/rooms/{id}/messages`), optionally as a reply.
   * `idempotencyKey` (a UUID) is sent as `Idempotency-Key`, so a retried send is one message. Returns its id.
   */
  async postMessage(
    roomId: string,
    token: string,
    message: { readonly content: string; readonly replyToMessageId: string | null },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = `${this.baseUrl}/api/v1/rooms/${encodeURIComponent(roomId)}/messages`;
    const body = await this.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        content: message.content,
        reply_to_message_id: message.replyToMessageId,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const posted = isRecord(body) && isRecord(body['message']) ? body['message'] : body;
    const id = isRecord(posted) ? posted['id'] : undefined;
    if (typeof id !== 'string' || id === '') fail('a posted message lacks id');
    return id;
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url, {
      ...init,
      signal: init.signal == null ? timeout : AbortSignal.any([init.signal, timeout]),
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new SharedNetAuthError(
        `SharedNet refused the request (HTTP ${String(response.status)}).`,
      );
    }
    if (!response.ok) {
      throw new SharedNetHttpError(`SharedNet returned HTTP ${String(response.status)}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new SharedNetContractError('SharedNet returned a non-JSON body.');
    }
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
    const name = isRecord(sender) ? sender['name'] : undefined;
    const reply = item['reply_to_message_id'];
    const type = item['type'];
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
      ...(typeof name === 'string' ? { senderName: name } : {}),
      ...(typeof reply === 'string' || reply === null ? { replyToMessageId: reply } : {}),
      ...(typeof type === 'string' ? { type } : {}),
    });
  }
  return { messages, hasMore: page['has_more'] === true };
}

const MEMBER_TOKEN = /^sni_[A-Za-z0-9_-]{16,256}$/;
const MEMBER_ID = /^i_[A-Za-z0-9]{6,64}$/;
const PRINCIPAL_ID = /^p_[A-Za-z0-9]{6,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseJoin(body: unknown): JoinResult {
  if (!isRecord(body)) fail('join body is not an object');
  const token = body['member_token'];
  if (typeof token !== 'string' || !MEMBER_TOKEN.test(token)) fail('join member_token is invalid');
  const history = body['history'];
  if (!isRecord(history) || !Array.isArray(history['items'])) fail('join history.items is missing');
  let lastSequence = 0;
  for (const item of history['items'] as unknown[]) {
    const sequence = isRecord(item) ? item['sequence'] : undefined;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
      fail('a join history item has an invalid sequence');
    }
    lastSequence = Math.max(lastSequence, sequence);
  }
  return { memberToken: token, lastSequence };
}

export function parseInstance(body: unknown): SeatIdentity {
  if (!isRecord(body)) fail('instances/current body is not an object');
  const principal = body['principal'];
  const instance = body['instance'];
  if (!isRecord(principal) || !isRecord(instance))
    fail('instances/current lacks principal or instance');
  const memberId = instance['id'];
  const principalId = instance['principal_id'];
  if (typeof memberId !== 'string' || !MEMBER_ID.test(memberId)) fail('instance.id is invalid');
  if (typeof principalId !== 'string' || !PRINCIPAL_ID.test(principalId)) {
    fail('instance.principal_id is invalid');
  }
  if (principal['id'] !== principalId) fail('principal.id does not match instance.principal_id');
  if (instance['revoked_at'] !== null) fail('the instance is revoked or revoked_at is missing');
  return { memberId, principalId };
}
