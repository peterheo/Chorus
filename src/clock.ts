// All time comes from an injected Clock (spec §17.1), never Date.now() directly.

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Replay clock: only moves when told to. */
export class VirtualClock implements Clock {
  private ms: number;

  constructor(start: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.ms = start.getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  set(to: Date): void {
    if (to.getTime() < this.ms) throw new Error("VirtualClock cannot move backwards");
    this.ms = to.getTime();
  }

  advanceSeconds(seconds: number): void {
    this.ms += seconds * 1000;
  }
}
