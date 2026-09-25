// Client-side rate limiting for an LLM API with per-model quotas (Gemini:
// requests per minute, input tokens per minute, requests per day, each per
// model). Chorus checks here before every request so it stays under the
// quota instead of discovering it through 429s, and records the cooldown a
// 429 asks for so it does not hammer a model that already said no.

export interface RateLimits {
  /** requests per minute */
  rpm?: number;
  /** input tokens per minute */
  tpm?: number;
  /** requests per day (Gemini's day resets at midnight Pacific time) */
  rpd?: number;
}

interface ModelState {
  /** start times of requests in the last minute */
  requests: number[];
  /** [time, input tokens] of requests in the last minute */
  tokens: Array<[number, number]>;
  day: string;
  dayCount: number;
  coolUntil: number;
}

const MINUTE = 60_000;
const pacificDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
const pacificClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Los_Angeles",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Milliseconds from `t` to the next midnight in Pacific time. */
export function msToPacificMidnight(t: number): number {
  const [h, m, s] = pacificClock.format(t).split(":").map(Number) as [number, number, number];
  return (24 * 3600 - (h * 3600 + m * 60 + s)) * 1000 - (t % 1000);
}

export class RateLimiter {
  private readonly models = new Map<string, ModelState>();

  constructor(
    private readonly limits: RateLimits,
    private readonly now: () => number = Date.now,
  ) {}

  private state(model: string): ModelState {
    const t = this.now();
    let s = this.models.get(model);
    if (!s) {
      s = { requests: [], tokens: [], day: pacificDay.format(t), dayCount: 0, coolUntil: 0 };
      this.models.set(model, s);
    }
    while (s.requests.length && t - s.requests[0]! >= MINUTE) s.requests.shift();
    while (s.tokens.length && t - s.tokens[0]![0] >= MINUTE) s.tokens.shift();
    const day = pacificDay.format(t);
    if (day !== s.day) {
      s.day = day;
      s.dayCount = 0;
    }
    return s;
  }

  /** How long until `model` can take a request of about `tokens` input tokens (0 = now). */
  wait(model: string, tokens = 0): number {
    const t = this.now();
    const s = this.state(model);
    const { rpm, tpm, rpd } = this.limits;
    let w = Math.max(0, s.coolUntil - t);
    if (rpd !== undefined && s.dayCount >= rpd) w = Math.max(w, msToPacificMidnight(t));
    if (rpm !== undefined && s.requests.length >= rpm) {
      w = Math.max(w, s.requests[s.requests.length - rpm]! + MINUTE - t);
    }
    if (tpm !== undefined && s.tokens.length) {
      // Wait until enough of the window expires; a request bigger than the
      // whole budget goes through on an empty window.
      let used = s.tokens.reduce((a, [, n]) => a + n, 0);
      for (const [at, n] of s.tokens) {
        if (used + tokens <= tpm) break;
        used -= n;
        w = Math.max(w, at + MINUTE - t);
      }
    }
    return w;
  }

  /**
   * Count a request against `model` with an estimate of its input tokens.
   * `settle` replaces the estimate with the actual count; `refund` takes the
   * request back when the API rejected it without serving it (429, 5xx).
   */
  take(model: string, tokens: number): { settle(actual: number | null): void; refund(): void } {
    const s = this.state(model);
    const t = this.now();
    s.requests.push(t);
    s.dayCount++;
    const entry: [number, number] = [t, tokens];
    s.tokens.push(entry);
    return {
      settle: (actual) => {
        if (actual != null) entry[1] = actual;
      },
      refund: () => {
        const i = s.requests.lastIndexOf(t);
        if (i >= 0) s.requests.splice(i, 1);
        const j = s.tokens.indexOf(entry);
        if (j >= 0) s.tokens.splice(j, 1);
        if (s.dayCount > 0) s.dayCount--;
      },
    };
  }

  /** Stop using `model` for `ms` (a 429's retry delay, or a backoff). */
  cooldown(model: string, ms: number): void {
    const s = this.state(model);
    s.coolUntil = Math.max(s.coolUntil, this.now() + ms);
  }

  /** `alias` turned out to share `model`'s quota: fold what was counted under it into `model`. */
  merge(alias: string, model: string): void {
    if (alias === model || !this.models.has(alias)) return;
    const from = this.state(alias);
    const into = this.state(model);
    into.requests = [...into.requests, ...from.requests].sort((x, y) => x - y);
    into.tokens = [...into.tokens, ...from.tokens].sort((x, y) => x[0] - y[0]);
    into.dayCount += from.dayCount;
    into.coolUntil = Math.max(into.coolUntil, from.coolUntil);
    this.models.delete(alias);
  }

  /** Requests made to `model` today (Pacific time). */
  usedToday(model: string): number {
    return this.state(model).dayCount;
  }
}
