import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEASE_DURATION_SECONDS,
  MAX_LEASE_DURATION_SECONDS,
  resolveLeaseDurationSeconds,
} from '../../src/config.ts';

describe('lease duration', () => {
  it('defaults to 15 minutes', () => {
    expect(DEFAULT_LEASE_DURATION_SECONDS).toBe(900);
    expect(resolveLeaseDurationSeconds(undefined)).toBe(900);
  });

  it('accepts a configured integer number of seconds', () => {
    expect(resolveLeaseDurationSeconds(60)).toBe(60);
    expect(resolveLeaseDurationSeconds(MAX_LEASE_DURATION_SECONDS)).toBe(
      MAX_LEASE_DURATION_SECONDS,
    );
  });

  it.each([0, -5, 1.5, Number.NaN, MAX_LEASE_DURATION_SECONDS + 1])('rejects %s', (bad) => {
    expect(() => resolveLeaseDurationSeconds(bad)).toThrow(/leaseDurationSeconds/);
  });
});
