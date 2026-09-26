/** Stable machine-readable codes (design §12.4) mapped to their HTTP status. */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  action_forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  lease_conflict: 409,
  lease_lost: 409,
  idempotency_conflict: 409,
  subject_digest_mismatch: 409,
  invalid_transition: 422,
  evidence_required: 422,
  review_required: 422,
  precondition_required: 428,
  internal_error: 500,
  temporarily_unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ChorusErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** A domain error that carries its stable code. Never thrown for unexpected faults; those stay as-is. */
export class ChorusError extends Error {
  override readonly name = 'ChorusError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options: ChorusErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options.details ?? {};
  }

  /** Only a retry of the same idempotency key can succeed for these. */
  get retryable(): boolean {
    return this.code === 'temporarily_unavailable';
  }
}

export function isChorusError(value: unknown, code?: ErrorCode): value is ChorusError {
  return value instanceof ChorusError && (code === undefined || value.code === code);
}
