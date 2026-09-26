/** In-memory fixed-window limiter, per process. Enough for RC1's single-instance service. */
export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

export interface RateDecision {
  readonly ok: boolean;
  readonly retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  hit(key: string): RateDecision {
    const now = this.now();
    if (this.buckets.size > 10_000) this.sweep(now);
    const bucket = this.buckets.get(key);
    if (bucket === undefined || now - bucket.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return { ok: true, retryAfterSeconds: 0 };
    }
    bucket.count++;
    if (bucket.count <= this.limit) return { ok: true, retryAfterSeconds: 0 };
    const remainingMs = bucket.windowStart + this.windowMs - now;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.buckets.delete(key);
    }
  }
}
