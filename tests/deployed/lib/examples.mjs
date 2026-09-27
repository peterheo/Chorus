import { redact } from './redact.mjs';

const PAGE_EXAMPLE_CONTENT = 'Both acceptance criteria are met.';
const CONTENT_SENTINEL = '__CHORUS_PAGE_EXAMPLE_CONTENT__';
const CONTENT_KEY = '__chorus_page_example_content';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;

function sanitize(value, key, replacements) {
  if (key === 'content') return CONTENT_SENTINEL;
  if (key === 'idempotency_key') return '<uuid>';
  if (key === 'content_sha256') return '<sha256>';
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, undefined, replacements));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, entry]) => [
        childKey === 'content' ? CONTENT_KEY : childKey,
        sanitize(entry, childKey, replacements),
      ]),
    );
  }
  if (typeof value !== 'string') return value;
  if (replacements.has(value)) return replacements.get(value);
  if (UUID.test(value)) return '<uuid>';
  if (SHA256.test(value)) return '<sha256>';
  return value;
}

function restoreContent(value) {
  if (Array.isArray(value)) return value.map(restoreContent);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key === CONTENT_KEY ? 'content' : key,
        restoreContent(entry),
      ]),
    );
  }
  return value === CONTENT_SENTINEL ? PAGE_EXAMPLE_CONTENT : value;
}

/** Build a page-safe, placeholder-only view of the captured E6 request/response pairs. */
export function buildPageExamples(calls, identifiers = {}) {
  const replacements = new Map(Object.entries(identifiers));
  const sanitized = calls.map(({ name, request, response }) => ({
    name,
    request: sanitize(request, undefined, replacements),
    response: sanitize(response, undefined, replacements),
  }));
  return restoreContent(redact(sanitized));
}
