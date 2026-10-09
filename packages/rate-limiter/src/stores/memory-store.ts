import type { ConsumeOptions, ConsumeResult, RateLimitStore } from '../core/types.js';

interface FixedWindowEntry {
  count: number;
  resetAt: number;
}

export interface MemoryStoreOptions {
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** How often expired entries are swept. `0` disables the sweeper. Defaults to 60s. */
  sweepIntervalMs?: number;
}

/**
 * Single-process store for unit tests, local development and library consumers that run
 * one instance. Node's event loop makes each `consume` call atomic, so no locking is needed.
 */
export class MemoryStore implements RateLimitStore {
  private readonly fixed = new Map<string, FixedWindowEntry>();
  private readonly sliding = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    const interval = options.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => this.sweep(), interval);
      this.timer.unref();
    }
  }

  async consume(key: string, options: ConsumeOptions): Promise<ConsumeResult> {
    return options.algorithm === 'sliding-log'
      ? this.consumeSlidingLog(key, options.limit, options.windowMs)
      : this.consumeFixedWindow(key, options.limit, options.windowMs);
  }

  async reset(key: string): Promise<void> {
    this.fixed.delete(key);
    this.sliding.delete(key);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.fixed.clear();
    this.sliding.clear();
  }

  /** Number of tracked keys. */
  get size(): number {
    return this.fixed.size + this.sliding.size;
  }

  private consumeFixedWindow(key: string, limit: number, windowMs: number): ConsumeResult {
    const now = this.now();
    let entry = this.fixed.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.fixed.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= limit, count: entry.count, resetMs: entry.resetAt - now };
  }

  private consumeSlidingLog(key: string, limit: number, windowMs: number): ConsumeResult {
    const now = this.now();
    const cutoff = now - windowMs;

    // Timestamps are appended in order, so expired entries form a prefix of the log.
    let log = this.sliding.get(key) ?? [];
    let expired = 0;
    while (expired < log.length && (log[expired] as number) <= cutoff) expired += 1;
    if (expired > 0) log = log.slice(expired);

    // Denied requests are not recorded: retrying while blocked must not extend the lock-out.
    const allowed = log.length < limit;
    if (allowed) log.push(now);

    if (log.length === 0) this.sliding.delete(key);
    else this.sliding.set(key, log);

    const oldest = log[0];
    const resetMs = oldest === undefined ? windowMs : oldest + windowMs - now;
    return { allowed, count: log.length, resetMs };
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.fixed) {
      if (entry.resetAt <= now) this.fixed.delete(key);
    }
    // A sliding log does not remember its window, so the sweeper only drops logs that have
    // been idle for a generous bound; `consumeSlidingLog` prunes precisely on access.
    const idleCutoff = now - 24 * 60 * 60 * 1000;
    for (const [key, log] of this.sliding) {
      const newest = log[log.length - 1];
      if (newest === undefined || newest <= idleCutoff) this.sliding.delete(key);
    }
  }
}
