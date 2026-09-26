import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  claim,
  completeTask,
  createTask,
  getResult,
  getTask,
  listMyReviews,
  listWork,
  renewLease,
  requestReview,
  reviewVerdict,
  submitResult,
  type CommandContext,
} from '../../src/index.ts';
import { ERROR_STATUS, isChorusError } from '../../src/errors.ts';
import type { Uuid } from '../../src/ids.ts';
import {
  decodeCursor,
  encodeCursor,
  requireArray,
  requireEnum,
  requireInteger,
  requireObject,
  requireSha256,
  requireString,
  requireTitle,
  requireUuid,
} from '../../src/validation.ts';

const id = '0000000a-0000-7000-8000-00000000000a';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isChorusError(error) ? `${error.code}:${String(error.details['field'])}` : String(error);
  }
  return 'ok';
}

describe('submit.validation (unit): limits are enforced without touching the database', () => {
  it('counts UTF-8 bytes, not characters or UTF-16 units', () => {
    const emoji = '🚀'; // 4 bytes, 1 code point, 2 UTF-16 units
    expect(code(() => requireString(emoji.repeat(65536), 'content', { maxBytes: 262144 }))).toBe(
      'ok',
    );
    expect(code(() => requireString(emoji.repeat(65537), 'content', { maxBytes: 262144 }))).toBe(
      'invalid_request:content',
    );
    expect(code(() => requireString('a'.repeat(262145), 'content', { maxBytes: 262144 }))).toBe(
      'invalid_request:content',
    );
    expect(code(() => requireString('', 'content', { minBytes: 1 }))).toBe(
      'invalid_request:content',
    );
  });

  it('counts code points for text limits', () => {
    expect(code(() => requireString('🚀'.repeat(500), 'c', { maxCodePoints: 500 }))).toBe('ok');
    expect(code(() => requireString('🚀'.repeat(501), 'c', { maxCodePoints: 500 }))).toBe(
      'invalid_request:c',
    );
  });

  it('rejects NUL and lone surrogates, which cannot round-trip verbatim', () => {
    expect(code(() => requireString('a\u0000b', 'content', {}))).toBe('invalid_request:content');
    expect(code(() => requireString('bad \ud800', 'content', {}))).toBe('invalid_request:content');
    expect(code(() => requireString('fine 🚀', 'content', {}))).toBe('ok');
  });

  it('validates titles: length, blank, control characters', () => {
    expect(code(() => requireTitle('A fine title'))).toBe('ok');
    expect(code(() => requireTitle(''))).toBe('invalid_request:title');
    expect(code(() => requireTitle('   '))).toBe('invalid_request:title');
    expect(code(() => requireTitle('x'.repeat(201)))).toBe('invalid_request:title');
    expect(code(() => requireTitle('x'.repeat(200)))).toBe('ok');
    expect(code(() => requireTitle('line\nbreak'))).toBe('invalid_request:title');
    expect(code(() => requireTitle('tab\there'))).toBe('invalid_request:title');
    expect(code(() => requireTitle(42))).toBe('invalid_request:title');
  });

  it('validates integers, uuids, digests, enums, arrays and unknown fields', () => {
    expect(code(() => requireInteger(1.5, 'n', 1))).toBe('invalid_request:n');
    expect(code(() => requireInteger('1', 'n', 1))).toBe('invalid_request:n');
    expect(code(() => requireInteger(0, 'expected_version', 1))).toBe(
      'invalid_request:expected_version',
    );
    expect(code(() => requireUuid('nope', 'task_id'))).toBe('invalid_request:task_id');
    expect(requireUuid(id.toUpperCase(), 'task_id')).toBe(id);
    expect(code(() => requireSha256('ABC', 'd'))).toBe('invalid_request:d');
    expect(code(() => requireSha256('a'.repeat(64), 'd'))).toBe('ok');
    expect(code(() => requireEnum('x', 'verdict', ['approved']))).toBe('invalid_request:verdict');
    expect(code(() => requireArray([], 'a', 1, 20))).toBe('invalid_request:a');
    expect(code(() => requireArray(new Array(21).fill(0), 'a', 1, 20))).toBe('invalid_request:a');
    expect(code(() => requireObject({ a: 1, b: 2 }, ['a']))).toBe('invalid_request:b');
    expect(code(() => requireObject([], ['a']))).toBe('invalid_request:input');
    expect(code(() => requireObject(null, ['a']))).toBe('invalid_request:input');
  });

  it('round-trips cursors and rejects malformed ones', () => {
    expect(decodeCursor(encodeCursor(id))).toBe(id);
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(code(() => decodeCursor('!!!'))).toBe('invalid_request:cursor');
    expect(code(() => decodeCursor(Buffer.from('nope').toString('base64url')))).toBe(
      'invalid_request:cursor',
    );
    expect(code(() => decodeCursor(7))).toBe('invalid_request:cursor');
  });
});

describe('errors.precedence (unit): input validation runs before any database access', () => {
  // A pool that fails loudly if a command reaches the database.
  const pool = {
    connect: () => Promise.reject(new Error('the database must not be touched')),
    query: () => Promise.reject(new Error('the database must not be touched')),
  } as unknown as pg.Pool;
  const ctx: CommandContext = {
    pool,
    workspaceId: id as Uuid,
    actorId: id as Uuid,
    instanceId: null,
    idempotencyKey: 'key-1',
  };
  const read = { pool, workspaceId: id as Uuid, actorId: id as Uuid };

  const bad: [string, () => Promise<unknown>][] = [
    ['create_task', () => createTask(ctx, { room_id: id, title: '', acceptance_criteria: ['c'] })],
    [
      'create_task criteria',
      () => createTask(ctx, { room_id: id, title: 't', acceptance_criteria: [] }),
    ],
    ['claim', () => claim(ctx, { task_id: 'x', expected_version: 1 })],
    ['renew_lease', () => renewLease(ctx, { task_id: id, expected_version: 0, fence: 1 })],
    [
      'submit_result',
      () =>
        submitResult(ctx, {
          task_id: id,
          expected_version: 1,
          fence: 1,
          content: '',
          content_type: 'text/plain',
          criteria_mapping: [],
        }),
    ],
    [
      'request_review',
      () =>
        requestReview(ctx, {
          task_id: id,
          expected_version: 1,
          revision: 0,
          reviewer_actor_id: id,
        }),
    ],
    [
      'review_verdict',
      () =>
        reviewVerdict(ctx, {
          review_id: id,
          expected_version: 1,
          verdict: 'maybe',
          content_sha256: 'a'.repeat(64),
        }),
    ],
    ['complete', () => completeTask(ctx, { task_id: id })],
    ['list_work', () => listWork(read, { limit: 999 })],
    ['get_task', () => getTask(read, {})],
    ['get_result', () => getResult(read, { task_id: id, revision: 'one' })],
    ['list_my_reviews', () => listMyReviews(read, { cursor: '###' })],
  ];

  it.each(bad)(
    '%s rejects bad input with invalid_request (400) and no database call',
    async (_name, run) => {
      const error = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isChorusError(error, 'invalid_request')).toBe(true);
      expect((error as { status: number }).status).toBe(400);
    },
  );

  it('maps the RC-WP2 error codes to their statuses', () => {
    expect(ERROR_STATUS.owner_conflict).toBe(409);
    expect(ERROR_STATUS.review_stale).toBe(409);
    expect(ERROR_STATUS.review_exists).toBe(409);
    expect(ERROR_STATUS.lease_lost).toBe(409);
    expect(ERROR_STATUS.lease_conflict).toBe(409);
    expect(ERROR_STATUS.subject_digest_mismatch).toBe(409);
    expect(ERROR_STATUS.evidence_required).toBe(422);
    expect(ERROR_STATUS.review_required).toBe(422);
    expect(ERROR_STATUS.invalid_transition).toBe(422);
  });
});
