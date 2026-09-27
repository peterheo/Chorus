export interface CreditTransfer {
  readonly id: string;
  readonly from_principal_id: string;
  readonly to_principal_id: string;
  readonly amount: number;
  readonly memo: string | null;
  readonly room_id: string | null;
  readonly by_instance_id: string | null;
  readonly addressed_to: string;
  readonly code: string | null;
  readonly created_at: string;
}

export interface LedgerPage {
  readonly items: readonly CreditTransfer[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

export interface TransferRequest {
  /** The receiving seat (`i_…`). */
  readonly to: string;
  readonly amount: number;
  readonly memo: string;
  /** The SharedNet room (`rom_…`) the transfer is made in. */
  readonly roomId: string;
  /** SharedNet's Idempotency-Key (a UUID): every retry of one transfer must reuse it. */
  readonly idempotencyKey: string;
}

export interface LedgerClient {
  listTransfers(
    args: { readonly limit: number; readonly before?: string },
    signal: AbortSignal,
  ): Promise<LedgerPage>;
  /**
   * Sends credits from the client's own seat (Chorus uses it only for refunds). Optional so a read-only
   * ledger (tests, fakes) needs no stub; a client without it cannot refund, and the refund stays pending.
   */
  transfer?(request: TransferRequest, signal: AbortSignal): Promise<{ readonly id: string }>;
}

export interface HttpLedgerClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class LedgerUnavailableError extends Error {
  readonly cause_code: 'http_status' | 'timeout' | 'network' | 'contract_mismatch' | 'rate_limited';
  readonly http_status?: number;

  constructor(causeCode: LedgerUnavailableError['cause_code'], httpStatus?: number) {
    super(`SharedNet ledger unavailable (${causeCode}).`);
    this.name = 'LedgerUnavailableError';
    this.cause_code = causeCode;
    if (httpStatus !== undefined) this.http_status = httpStatus;
  }
}

const beforePattern = /^txn_[A-Za-z0-9]{6,64}$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTransfer(value: unknown): value is CreditTransfer {
  if (!isRecord(value)) return false;
  const stringFields = [
    'id',
    'from_principal_id',
    'to_principal_id',
    'addressed_to',
    'created_at',
  ] as const;
  if (stringFields.some((field) => typeof value[field] !== 'string' || value[field] === '')) {
    return false;
  }
  if (
    typeof value['amount'] !== 'number' ||
    !Number.isInteger(value['amount']) ||
    value['amount'] < 1
  ) {
    return false;
  }
  for (const field of ['memo', 'room_id', 'by_instance_id', 'code'] as const) {
    if (value[field] !== null && typeof value[field] !== 'string') return false;
  }
  const createdAt = value['created_at'];
  return (
    typeof createdAt === 'string' &&
    isoDatePattern.test(createdAt) &&
    Number.isFinite(Date.parse(createdAt))
  );
}

function parsePage(value: unknown): LedgerPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value['items']) ||
    !(
      value['next_cursor'] === null ||
      (typeof value['next_cursor'] === 'string' && beforePattern.test(value['next_cursor']))
    ) ||
    typeof value['has_more'] !== 'boolean' ||
    !value['items'].every(isTransfer)
  ) {
    throw new LedgerUnavailableError('contract_mismatch');
  }
  return {
    items: value['items'],
    next_cursor: value['next_cursor'],
    has_more: value['has_more'],
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createHttpLedgerClient(options: HttpLedgerClientOptions): LedgerClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  /** One request with the shared timeout, error mapping and JSON parsing. */
  async function call(url: URL, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: combinedSignal });
    } catch (error) {
      if (combinedSignal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new LedgerUnavailableError('timeout');
      }
      throw new LedgerUnavailableError('network');
    }
    if (!response.ok) {
      if (response.status === 429) throw new LedgerUnavailableError('rate_limited');
      throw new LedgerUnavailableError('http_status', response.status);
    }
    try {
      return await response.json();
    } catch (error) {
      if (combinedSignal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new LedgerUnavailableError('timeout');
      }
      throw new LedgerUnavailableError('contract_mismatch');
    }
  }

  return {
    async transfer(request, signal): Promise<{ readonly id: string }> {
      if (!Number.isInteger(request.amount) || request.amount < 1) {
        throw new RangeError('amount must be a positive integer.');
      }
      if (!uuidPattern.test(request.idempotencyKey)) {
        throw new RangeError('idempotencyKey must be a UUID.');
      }
      const body = await call(
        new URL('/api/v1/credits/transfers', options.baseUrl),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Idempotency-Key': request.idempotencyKey,
          },
          body: JSON.stringify({
            to: request.to,
            amount: request.amount,
            memo: request.memo,
            room_id: request.roomId,
          }),
        },
        signal,
      );
      // 201: `{ transfer, purse }`; only the transfer's id is needed.
      const transfer = isRecord(body) ? body['transfer'] : undefined;
      const id = isRecord(transfer) ? transfer['id'] : undefined;
      if (typeof id !== 'string' || !beforePattern.test(id)) {
        throw new LedgerUnavailableError('contract_mismatch');
      }
      return { id };
    },

    async listTransfers(args, signal): Promise<LedgerPage> {
      if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
        throw new RangeError('limit must be an integer from 1 through 100.');
      }
      if (args.before !== undefined && !beforePattern.test(args.before)) {
        throw new RangeError('before must be a valid transaction id.');
      }

      const url = new URL('/api/v1/credits/transfers', options.baseUrl);
      url.searchParams.set('limit', String(args.limit));
      if (args.before !== undefined) url.searchParams.set('before', args.before);
      const body = await call(
        url,
        { headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' } },
        signal,
      );
      return parsePage(body);
    },
  };
}

export interface PaymentExpectation {
  readonly txnId: string;
  readonly payeePrincipalId: string;
  readonly payeeMemberId: string;
  readonly requesterMemberId: string;
  readonly roomId: string;
  readonly amount: number;
  readonly memo: string;
  readonly quoteCreatedAt: Date;
}

export type NotVerifiedReason = 'payee' | 'payer_seat' | 'room' | 'amount' | 'memo' | 'age';

export type VerifyResult =
  | { readonly status: 'verified'; readonly transfer: CreditTransfer }
  | { readonly status: 'not_found'; readonly pagesScanned: number }
  | {
      readonly status: 'not_verified';
      readonly reason: NotVerifiedReason;
      readonly observed: CreditTransfer;
    }
  | { readonly status: 'unavailable'; readonly cause: LedgerUnavailableError['cause_code'] };

export interface VerifyOptions {
  readonly maxPages?: number;
  readonly pageSize?: number;
  readonly ageSlackMs?: number;
}

const txnPattern = /^txn_[A-Za-z0-9]{6,64}$/;
const memberPattern = /^i_[A-Za-z0-9]{6,64}$/;

export async function verifyPayment(
  client: LedgerClient,
  expectation: PaymentExpectation,
  options: VerifyOptions = {},
  signal?: AbortSignal,
): Promise<VerifyResult> {
  if (
    !txnPattern.test(expectation.txnId) ||
    !Number.isInteger(expectation.amount) ||
    expectation.amount < 1 ||
    !memberPattern.test(expectation.requesterMemberId) ||
    !(expectation.quoteCreatedAt instanceof Date) ||
    Number.isNaN(expectation.quoteCreatedAt.getTime())
  ) {
    throw new TypeError('Invalid payment expectation.');
  }
  const maxPages = options.maxPages ?? 5;
  const pageSize = options.pageSize ?? 100;
  const ageSlackMs = options.ageSlackMs ?? 60_000;
  if (
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 20 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    throw new RangeError('maxPages must be from 1 through 20 and pageSize from 1 through 100.');
  }
  const oldestAllowed = expectation.quoteCreatedAt.getTime() - ageSlackMs;
  let before: string | undefined;
  let pagesScanned = 0;

  try {
    while (pagesScanned < maxPages) {
      const args = before === undefined ? { limit: pageSize } : { limit: pageSize, before };
      const page = await client.listTransfers(args, signal ?? new AbortController().signal);
      pagesScanned += 1;
      for (const item of page.items) {
        if (item.id === expectation.txnId) {
          if (
            item.to_principal_id !== expectation.payeePrincipalId ||
            (item.addressed_to !== expectation.payeeMemberId &&
              item.addressed_to !== expectation.payeePrincipalId)
          ) {
            return { status: 'not_verified', reason: 'payee', observed: item };
          }
          if (
            item.by_instance_id === null ||
            item.by_instance_id !== expectation.requesterMemberId
          ) {
            return { status: 'not_verified', reason: 'payer_seat', observed: item };
          }
          if (item.room_id !== expectation.roomId) {
            return { status: 'not_verified', reason: 'room', observed: item };
          }
          if (item.amount !== expectation.amount) {
            return { status: 'not_verified', reason: 'amount', observed: item };
          }
          if (item.memo !== expectation.memo) {
            return { status: 'not_verified', reason: 'memo', observed: item };
          }
          if (Date.parse(item.created_at) < oldestAllowed) {
            return { status: 'not_verified', reason: 'age', observed: item };
          }
          return { status: 'verified', transfer: item };
        }
        if (Date.parse(item.created_at) < oldestAllowed) {
          return { status: 'not_found', pagesScanned };
        }
      }
      if (!page.has_more || pagesScanned >= maxPages) break;
      before = page.next_cursor ?? page.items.at(-1)?.id;
      if (before === undefined) break;
    }
    return { status: 'not_found', pagesScanned };
  } catch (error) {
    if (error instanceof LedgerUnavailableError) {
      return { status: 'unavailable', cause: error.cause_code };
    }
    throw error;
  }
}
