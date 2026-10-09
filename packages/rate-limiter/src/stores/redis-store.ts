import { randomUUID } from 'node:crypto';
import { Redis, type RedisOptions } from 'ioredis';
import type { ConsumeOptions, ConsumeResult, RateLimitStore } from '../core/types.js';
import { FIXED_WINDOW_SCRIPT, SLIDING_LOG_SCRIPT } from './lua-scripts.js';

/** ioredis `defineCommand` registers scripts as client methods; this is their shape. */
interface ScriptCommands {
  rlFixedWindow(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<[number, number]>;
  rlSlidingLog(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
    member: string,
  ): Promise<[number, number, number]>;
}

export interface RedisStoreOptions {
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Receives connection-level errors of a client the store created itself. */
  onError?: (error: Error) => void;
}

/**
 * Connection defaults tuned for a rate limiter: fail fast so a Redis outage degrades into
 * the limiter's failure policy within about a second instead of stalling every request
 * while ioredis retries in the background.
 */
export const DEFAULT_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
  commandTimeout: 1_000,
  enableOfflineQueue: true,
};

/** Anything that quacks like an ioredis client, including `ioredis-mock`. */
export function isRedisClient(value: unknown): value is Redis {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Redis).defineCommand === 'function' &&
    typeof (value as Redis).del === 'function'
  );
}

/**
 * Redis-backed store. Pass an existing ioredis client to share a connection (the store will
 * not close it), or a URL / options object and the store owns and closes the client.
 */
export class RedisStore implements RateLimitStore {
  private readonly redis: Redis & ScriptCommands;
  private readonly ownsClient: boolean;
  private readonly now: () => number;

  constructor(
    client: Redis | string | RedisOptions = 'redis://localhost:6379',
    options: RedisStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;

    if (isRedisClient(client)) {
      this.redis = client as Redis & ScriptCommands;
      this.ownsClient = false;
    } else {
      this.redis = (
        typeof client === 'string'
          ? new Redis(client, DEFAULT_REDIS_OPTIONS)
          : new Redis({ ...DEFAULT_REDIS_OPTIONS, ...client })
      ) as Redis & ScriptCommands;
      this.ownsClient = true;
      // Without any listener ioredis prints every connection error to stderr.
      this.redis.on('error', (error: Error) => options.onError?.(error));
    }

    // defineCommand sends EVALSHA and falls back to EVAL transparently, so the script body
    // crosses the wire once per connection. Re-defining on a shared client is harmless.
    this.redis.defineCommand('rlFixedWindow', { numberOfKeys: 1, lua: FIXED_WINDOW_SCRIPT });
    this.redis.defineCommand('rlSlidingLog', { numberOfKeys: 1, lua: SLIDING_LOG_SCRIPT });
  }

  async consume(key: string, options: ConsumeOptions): Promise<ConsumeResult> {
    const { limit, algorithm } = options;
    const windowMs = Math.ceil(options.windowMs);
    const now = Math.floor(this.now());

    if (algorithm === 'sliding-log') {
      const [allowed, count, resetMs] = await this.redis.rlSlidingLog(
        key,
        limit,
        windowMs,
        now,
        randomUUID(),
      );
      return { allowed: allowed === 1, count, resetMs };
    }

    const [count, resetMs] = await this.redis.rlFixedWindow(key, limit, windowMs, now);
    return { allowed: count <= limit, count, resetMs };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.redis.quit();
  }
}
