import { Redis, type RedisOptions } from 'ioredis';
import type { Override, OverrideContext, OverrideStore } from '../core/types.js';
import { DEFAULT_REDIS_OPTIONS, isRedisClient } from '../stores/redis-store.js';
import { pickOverride, validateOverride } from './match.js';

export interface RedisOverrideStoreOptions {
  /** Redis hash holding all overrides (field = id, value = JSON). Defaults to `rl:overrides`. */
  key?: string;
  /**
   * How long the local snapshot is served before a background refresh is triggered. Bounds
   * how quickly other instances observe a change. Defaults to 5s.
   */
  refreshMs?: number;
  now?: () => number;
  /** Receives refresh failures and connection errors of a client the store created itself. */
  onError?: (error: Error) => void;
}

/**
 * Shared override store for multi-instance deployments.
 *
 * All overrides live in one Redis hash. Each process keeps a local snapshot and refreshes it
 * at most every `refreshMs` (stale-while-revalidate), so `resolve` costs zero network
 * round-trips on the hot path and an override becomes visible cluster-wide within
 * `refreshMs`. Writes go straight to Redis and update the local snapshot immediately.
 */
export class RedisOverrideStore implements OverrideStore {
  private readonly redis: Redis;
  private readonly ownsClient: boolean;
  private readonly key: string;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly onError: ((error: Error) => void) | undefined;

  private cache = new Map<string, Override>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;

  constructor(
    client: Redis | string | RedisOptions = 'redis://localhost:6379',
    options: RedisOverrideStoreOptions = {},
  ) {
    if (isRedisClient(client)) {
      this.redis = client;
      this.ownsClient = false;
    } else {
      this.redis =
        typeof client === 'string'
          ? new Redis(client, DEFAULT_REDIS_OPTIONS)
          : new Redis({ ...DEFAULT_REDIS_OPTIONS, ...client });
      this.ownsClient = true;
      this.redis.on('error', (error: Error) => options.onError?.(error));
    }
    this.key = options.key ?? 'rl:overrides';
    this.refreshMs = options.refreshMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  async resolve(ctx: OverrideContext): Promise<Override | undefined> {
    await this.ensureFresh(ctx.now);
    return pickOverride(this.cache.values(), ctx);
  }

  async list(): Promise<Override[]> {
    await this.load();
    return [...this.cache.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async put(override: Override): Promise<void> {
    validateOverride(override);
    await this.redis.hset(this.key, override.id, JSON.stringify(override));
    this.cache.set(override.id, override);
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.redis.hdel(this.key, id);
    this.cache.delete(id);
    return removed > 0;
  }

  /** Forces a synchronous reload of the snapshot. */
  async refresh(): Promise<void> {
    await this.load();
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.redis.quit();
  }

  private async ensureFresh(now: number): Promise<void> {
    if (now - this.loadedAt < this.refreshMs) return;

    if (!this.inflight) {
      this.inflight = this.load()
        .catch((error: unknown) => {
          // Keep serving the previous snapshot and back off until the next interval.
          this.onError?.(error as Error);
          this.loadedAt = now;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }

    // The very first load must complete so existing overrides are never silently ignored;
    // later refreshes run in the background (stale-while-revalidate).
    const neverLoaded = !Number.isFinite(this.loadedAt);
    if (neverLoaded && this.cache.size === 0) await this.inflight;
  }

  private async load(): Promise<void> {
    const now = this.now();
    const raw = await this.redis.hgetall(this.key);
    const next = new Map<string, Override>();
    const stale: string[] = [];

    for (const [id, json] of Object.entries(raw)) {
      let parsed: Override | undefined;
      try {
        parsed = JSON.parse(json) as Override;
      } catch {
        parsed = undefined; // corrupt entry
      }
      if (parsed && parsed.expiresAt > now) next.set(id, parsed);
      else stale.push(id);
    }

    if (stale.length > 0) {
      // Opportunistic garbage collection; a failure here is harmless.
      this.redis.hdel(this.key, ...stale).catch(() => undefined);
    }

    this.cache = next;
    this.loadedAt = now;
  }
}
