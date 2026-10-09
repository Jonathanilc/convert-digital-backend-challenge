import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RedisStore } from '../../src/stores/redis-store.js';
import { fakeClock } from '../helpers/clock.js';
import { connect, testPrefix } from '../helpers/redis.js';
import { runStoreContract } from './store-contract.js';

const clients: Redis[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.quit()));
});
const client = (): Redis => {
  const c = connect();
  clients.push(c);
  return c;
};

runStoreContract(
  'RedisStore (real Redis)',
  (clock) => new RedisStore(client(), { now: clock.now }),
);

describe('RedisStore specifics', () => {
  it('uses a hash with a TTL for fixed windows and a sorted set for sliding logs', async () => {
    const redis = client();
    const store = new RedisStore(redis, { now: fakeClock().now });
    const prefix = testPrefix('types');

    await store.consume(`${prefix}:fw`, { limit: 5, windowMs: 1_000, algorithm: 'fixed-window' });
    await store.consume(`${prefix}:sl`, { limit: 5, windowMs: 1_000, algorithm: 'sliding-log' });

    expect(await redis.type(`${prefix}:fw`)).toBe('hash');
    expect(await redis.type(`${prefix}:sl`)).toBe('zset');
    expect(await redis.pttl(`${prefix}:fw`)).toBeGreaterThan(0);
    expect(await redis.pttl(`${prefix}:sl`)).toBeGreaterThan(0);
    await redis.del(`${prefix}:fw`, `${prefix}:sl`);
  });

  it('does not close a client it was given', async () => {
    const redis = client();
    const quit = vi.spyOn(redis, 'quit');
    await new RedisStore(redis).close();
    expect(quit).not.toHaveBeenCalled();
    quit.mockRestore();
  });

  it('closes a client it created from a URL', async () => {
    const store = new RedisStore('redis://127.0.0.1:1', { onError: () => undefined });
    const owned = (store as unknown as { redis: Redis }).redis;
    expect(owned).toBeInstanceOf(Redis);
    const quit = vi.spyOn(owned, 'quit').mockResolvedValue('OK');
    await store.close();
    expect(quit).toHaveBeenCalledOnce();
    owned.disconnect();
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
