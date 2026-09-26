import { ChorusError } from './errors.ts';
import { parseUuid, type Uuid } from './ids.ts';

/**
 * Input validation (RC-WP2 spec section 3). Every check runs before any database access; a violation
 * is `400 invalid_request` naming the field. Unknown fields are rejected so a typo is never silently
 * ignored.
 */

export function invalid(field: string, message: string): ChorusError {
  return new ChorusError('invalid_request', message, { details: { field } });
}

export function codePoints(value: string): number {
  return Array.from(value).length;
}

/** Postgres cannot store NUL, and lone surrogates cannot round-trip through UTF-8 verbatim. */
function assertStorable(value: string, field: string): void {
  if (value.includes('\u0000')) throw invalid(field, `${field} must not contain NUL characters.`);
  if (!value.isWellFormed()) throw invalid(field, `${field} must be well-formed Unicode.`);
}

export function requireObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('input', 'Input must be a JSON object.');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw invalid(key, `Unknown field "${key}".`);
  }
  return record;
}

export function requireString(
  value: unknown,
  field: string,
  limits: { minCodePoints?: number; maxCodePoints?: number; maxBytes?: number; minBytes?: number },
): string {
  if (typeof value !== 'string') throw invalid(field, `${field} must be a string.`);
  assertStorable(value, field);
  if (limits.minCodePoints !== undefined || limits.maxCodePoints !== undefined) {
    const n = codePoints(value);
    if (limits.minCodePoints !== undefined && n < limits.minCodePoints) {
      throw invalid(field, `${field} must be at least ${String(limits.minCodePoints)} characters.`);
    }
    if (limits.maxCodePoints !== undefined && n > limits.maxCodePoints) {
      throw invalid(field, `${field} must be at most ${String(limits.maxCodePoints)} characters.`);
    }
  }
  if (limits.minBytes !== undefined || limits.maxBytes !== undefined) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (limits.minBytes !== undefined && bytes < limits.minBytes) {
      throw invalid(field, `${field} must be at least ${String(limits.minBytes)} bytes.`);
    }
    if (limits.maxBytes !== undefined && bytes > limits.maxBytes) {
      throw invalid(field, `${field} must be at most ${String(limits.maxBytes)} bytes (UTF-8).`);
    }
  }
  return value;
}

/** Title rule: non-blank, no C0 control characters or DEL (Q4 default). */
export function requireTitle(value: unknown): string {
  const title = requireString(value, 'title', { minCodePoints: 1, maxCodePoints: 200 });
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(title)) {
    throw invalid('title', 'title must not contain control characters.');
  }
  if (title.trim() === '') throw invalid('title', 'title must contain a non-whitespace character.');
  return title;
}

export function requireNonBlank(value: unknown, field: string, maxCodePoints: number): string {
  const text = requireString(value, field, { minCodePoints: 1, maxCodePoints });
  if (text.trim() === '') throw invalid(field, `${field} must contain a non-whitespace character.`);
  return text;
}

export function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid(field, `${field} must be a boolean.`);
  return value;
}

export function requireInteger(value: unknown, field: string, min: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(field, `${field} must be an integer.`);
  }
  if (value < min || (max !== undefined && value > max)) {
    throw invalid(
      field,
      max === undefined
        ? `${field} must be at least ${String(min)}.`
        : `${field} must be between ${String(min)} and ${String(max)}.`,
    );
  }
  return value;
}

export function requireUuid(value: unknown, field: string): Uuid {
  const uuid = typeof value === 'string' ? parseUuid(value) : undefined;
  if (uuid === undefined) throw invalid(field, `${field} must be a UUID.`);
  return uuid;
}

export function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw invalid(field, `${field} must be a lowercase hex SHA-256 digest.`);
  }
  return value;
}

export function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(field, `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function requireArray(
  value: unknown,
  field: string,
  min: number,
  max: number,
): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(field, `${field} must be an array.`);
  if (value.length < min || value.length > max) {
    throw invalid(field, `${field} must contain between ${String(min)} and ${String(max)} items.`);
  }
  return value as readonly unknown[];
}

export function limitOrDefault(value: unknown): number {
  return value === undefined ? 20 : requireInteger(value, 'limit', 1, 50);
}

/** Pagination cursor: base64url of the last returned id (a UUID). */
export function decodeCursor(value: unknown): Uuid | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalid('cursor', 'cursor is malformed.');
  }
  const id = parseUuid(Buffer.from(value, 'base64url').toString('utf8'));
  if (id === undefined) throw invalid('cursor', 'cursor is malformed.');
  return id;
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}
