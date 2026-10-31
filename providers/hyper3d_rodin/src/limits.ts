import { randomInt } from 'node:crypto';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A clock for tests: sleeping advances time instantly and is recorded. */
export class VirtualClock implements Clock {
  private t: number;
  readonly sleeps: number[] = [];
  constructor(start = 1_800_000_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
    await Promise.resolve();
  }
  get slept(): number {
    return this.sleeps.reduce((a, b) => a + b, 0);
  }
}

/** Token bucket: `perMinute` requests per minute, with a burst of the same size. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly perMinute: number;
  private readonly clock: Clock;
  constructor(perMinute: number, clock: Clock) {
    this.perMinute = perMinute;
    this.clock = clock;
    this.tokens = perMinute;
    this.last = clock.now();
  }
  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) * this.perMinute) / 60_000);
    this.last = now;
  }
  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.clock.sleep(Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute));
    }
  }
}

/** A counting semaphore that remembers its high-water mark. */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  peak = 0;
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('semaphore capacity must be a positive integer');
  }
  get active(): number {
    return this.inFlight;
  }
  async acquire(): Promise<() => void> {
    if (this.inFlight >= this.capacity) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else this.inFlight--;
    };
  }
}

export const defaultRandom = (): number => randomInt(0, 1_000_000) / 1_000_000;

/** Exponential backoff with jitter: base * 2^attempt, scaled into [0.5, 1), never below `floorMs`. */
export function backoffMs(attempt: number, opts: { baseMs: number; capMs: number; random: () => number; floorMs?: number }): number {
  const raw = Math.min(opts.capMs, opts.baseMs * 2 ** attempt);
  return Math.max(opts.floorMs ?? 0, Math.round(raw * (0.5 + opts.random() / 2)));
}
