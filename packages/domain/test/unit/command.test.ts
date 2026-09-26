import { describe, expect, it } from 'vitest';
import { canonicalJson, hashRequest } from '../../src/command.ts';
import { ChorusError, ERROR_STATUS, isChorusError } from '../../src/errors.ts';
import { isUuid, parseUuid, sortedUniqueUuids, type Uuid } from '../../src/ids.ts';

const id = (s: string) => s as Uuid;
const A = id('0000000a-0000-7000-8000-00000000000a');
const B = id('0000000b-0000-7000-8000-00000000000b');

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"z":1}]},"b":1}',
    );
  });

  it('rejects values JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
  });
});

describe('hashRequest', () => {
  const base = {
    type: 'task.create',
    input: { a: 1, b: [1, 2] },
    targets: [{ id: A, expectedVersion: 3 }],
  };

  it('is stable across key order and target order', () => {
    const shuffled = {
      type: 'task.create',
      input: { b: [1, 2], a: 1 },
      targets: [{ id: A, expectedVersion: 3 }],
    };
    expect(hashRequest(shuffled)).toBe(hashRequest(base));
    expect(
      hashRequest({
        ...base,
        targets: [
          { id: B, expectedVersion: 1 },
          { id: A, expectedVersion: 3 },
        ],
      }),
    ).toBe(
      hashRequest({
        ...base,
        targets: [
          { id: A, expectedVersion: 3 },
          { id: B, expectedVersion: 1 },
        ],
      }),
    );
  });

  it('changes with the type, the input, the target, or its expected version', () => {
    const h = hashRequest(base);
    expect(hashRequest({ ...base, type: 'task.update' })).not.toBe(h);
    expect(hashRequest({ ...base, input: { a: 2, b: [1, 2] } })).not.toBe(h);
    expect(hashRequest({ ...base, targets: [{ id: B, expectedVersion: 3 }] })).not.toBe(h);
    expect(hashRequest({ ...base, targets: [{ id: A, expectedVersion: 4 }] })).not.toBe(h);
    expect(hashRequest({ ...base, targets: [{ id: A }] })).not.toBe(h);
  });

  it('is a sha256 hex digest', () => {
    expect(hashRequest(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ids', () => {
  it('validates and canonicalizes UUIDs', () => {
    expect(isUuid(A)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(A.toUpperCase())).toBe(false);
    expect(parseUuid(A.toUpperCase())).toBe(A);
    expect(parseUuid('nope')).toBeUndefined();
  });

  it('sorts ascending and de-duplicates', () => {
    expect(sortedUniqueUuids([B, A, B])).toEqual([A, B]);
  });
});

describe('ChorusError', () => {
  it('carries its stable code and HTTP status', () => {
    const error = new ChorusError('version_conflict', 'changed', {
      details: { current_version: 9 },
    });
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ current_version: 9 });
    expect(error.retryable).toBe(false);
    expect(isChorusError(error, 'version_conflict')).toBe(true);
    expect(isChorusError(error, 'not_found')).toBe(false);
  });

  it('maps the documented statuses', () => {
    expect(ERROR_STATUS.not_found).toBe(404);
    expect(ERROR_STATUS.precondition_required).toBe(428);
    expect(ERROR_STATUS.idempotency_conflict).toBe(409);
    expect(ERROR_STATUS.invalid_transition).toBe(422);
    expect(new ChorusError('temporarily_unavailable', 'x').retryable).toBe(true);
  });
});
