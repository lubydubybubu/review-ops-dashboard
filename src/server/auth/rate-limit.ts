/**
 * Failed-login limiter, in memory (single owner, single process). Per client key plus a
 * global ceiling, so rotating IPs does not buy unlimited guesses. A successful login
 * clears the client's failures.
 */

export interface RateLimitOptions {
  windowMs: number;
  maxPerKey: number;
  maxGlobal: number;
}

export const LOGIN_LIMITS: RateLimitOptions = { windowMs: 15 * 60_000, maxPerKey: 5, maxGlobal: 30 };

export class FailureLimiter {
  private readonly byKey = new Map<string, number[]>();
  private global: number[] = [];

  constructor(private readonly options: RateLimitOptions = LOGIN_LIMITS) {}

  private prune(list: number[], now: number): number[] {
    const since = now - this.options.windowMs;
    return list.filter((t) => t > since);
  }

  /** Seconds until another attempt is allowed, or 0 when allowed now. */
  retryAfter(key: string, now = Date.now()): number {
    const mine = this.prune(this.byKey.get(key) ?? [], now);
    this.global = this.prune(this.global, now);
    if (mine.length === 0) this.byKey.delete(key);
    else this.byKey.set(key, mine);

    const blockedUntil = (list: number[], max: number) =>
      list.length >= max ? list[list.length - max]! + this.options.windowMs : 0;
    const until = Math.max(blockedUntil(mine, this.options.maxPerKey), blockedUntil(this.global, this.options.maxGlobal));
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  recordFailure(key: string, now = Date.now()): void {
    this.byKey.set(key, [...(this.byKey.get(key) ?? []), now]);
    this.global.push(now);
  }

  recordSuccess(key: string): void {
    this.byKey.delete(key);
  }
}

export interface RequestLimitOptions {
  windowMs: number;
  maxPerKey: number;
  maxGlobal: number;
  /** Hard cap on tracked keys; when full, unknown keys are refused rather than evicting live ones. */
  maxKeys: number;
}

export const HANDOFF_LIMITS: RequestLimitOptions = { windowMs: 60_000, maxPerKey: 20, maxGlobal: 120, maxKeys: 2048 };

/** Fixed-window request limiter for the sign-in routes; bounded memory, shared per process. */
export class RequestLimiter {
  private readonly byKey = new Map<string, { count: number; until: number }>();
  private global = { count: 0, until: 0 };

  constructor(private readonly options: RequestLimitOptions = HANDOFF_LIMITS) {}

  /** true when the request may proceed (and counts it). */
  take(key: string, now = Date.now()): boolean {
    if (now >= this.global.until) this.global = { count: 0, until: now + this.options.windowMs };
    let entry = this.byKey.get(key);
    if (entry && entry.until <= now) {
      this.byKey.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (this.byKey.size >= this.options.maxKeys) {
        for (const [k, v] of this.byKey) if (v.until <= now) this.byKey.delete(k);
        if (this.byKey.size >= this.options.maxKeys) return false;
      }
      entry = { count: 0, until: now + this.options.windowMs };
      this.byKey.set(key, entry);
    }
    if (entry.count >= this.options.maxPerKey) return false;
    if (this.global.count >= this.options.maxGlobal) return false;
    entry.count++;
    this.global.count++;
    return true;
  }

  get size(): number {
    return this.byKey.size;
  }
}
