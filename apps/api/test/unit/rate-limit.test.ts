import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/rate-limit.ts';

describe('rate limiter (unit)', () => {
  it('allows `limit` hits per window per key, then reports Retry-After, then resets', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect([1, 2, 3].map(() => limiter.hit('a').ok)).toEqual([true, true, true]);
    now += 10_000;
    const blocked = limiter.hit('a');
    expect(blocked).toEqual({ ok: false, retryAfterSeconds: 50 });
    expect(limiter.hit('b').ok).toBe(true);
    now += 50_000;
    expect(limiter.hit('a').ok).toBe(true);
  });

  it('never reports a zero Retry-After', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    limiter.hit('k');
    now = 999;
    expect(limiter.hit('k').retryAfterSeconds).toBe(1);
  });
});
