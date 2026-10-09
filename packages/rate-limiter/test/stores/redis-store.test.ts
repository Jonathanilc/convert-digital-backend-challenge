import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, expect, it, vi } from 'vitest';
import { RedisStore } from '../../src/stores/redis-store.js';
import { fakeClock } from '../helpers/clock.js';
import { runStoreContract } from './store-contract.js';

runStoreContract(
  'RedisStore (ioredis-mock)',
  (clock) => new RedisStore(new RedisMock(), { now: clock.now }),
);

describe('RedisStore specifics', () => {
  it('uses a hash with a TTL for fixed windows and a sorted set for sliding logs', async () => {
    const redis = new RedisMock();
    const clock = fakeClock();
    const store = new RedisStore(redis, { now: clock.now });

    await store.consume('k:fw', { limit: 5, windowMs: 1_000, algorithm: 'fixed-window' });
    await store.consume('k:sl', { limit: 5, windowMs: 1_000, algorithm: 'sliding-log' });

    expect(await redis.type('k:fw')).toBe('hash');
    expect(await redis.type('k:sl')).toBe('zset');
    expect(await redis.pttl('k:fw')).toBeGreaterThan(0);
    expect(await redis.pttl('k:sl')).toBeGreaterThan(0);
    await redis.quit();
  });

  it('does not close a client it was given', async () => {
    const redis = new RedisMock();
    const quit = vi.spyOn(redis, 'quit');
    const store = new RedisStore(redis);
    await store.close();
    expect(quit).not.toHaveBeenCalled();
    await redis.quit();
  });

  it('closes a client it created from a URL', async () => {
    const store = new RedisStore('redis://127.0.0.1:1', { onError: () => undefined });
    const client = (store as unknown as { redis: Redis }).redis;
    expect(client).toBeInstanceOf(Redis);
    const quit = vi.spyOn(client, 'quit').mockResolvedValue('OK');
    await store.close();
    expect(quit).toHaveBeenCalledOnce();
    client.disconnect();
  });

  it('propagates backend failures to the caller instead of swallowing them', async () => {
    const failing = {
      defineCommand(name: string) {
        (this as Record<string, unknown>)[name] = async () => {
          throw new Error('READONLY You cannot write against a read only replica.');
        };
      },
      del: async () => 1,
      quit: async () => 'OK',
      on() {
        return this;
      },
    } as unknown as Redis;

    const store = new RedisStore(failing);
    await expect(
      store.consume('k', { limit: 1, windowMs: 1_000, algorithm: 'fixed-window' }),
    ).rejects.toThrow(/READONLY/);
  });
});
