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

  it('keeps younger sliding-log entries when the oldest one ages out (key TTL must follow the newest entry)', async () => {
    // Regression found by live verification: the key's TTL was set to the oldest entry's expiry, so
    // when Redis expired the key it dropped every younger entry too and the limiter under-counted.
    // The fake clock drives the window; Redis TTLs run on the wall clock, hence the real wait below.
    const redis = client();
    const clock = fakeClock();
    const store = new RedisStore(redis, { now: clock.now });
    const key = testPrefix('sliding-ttl');
    const opts = { limit: 2, windowMs: 1_000, algorithm: 'sliding-log' as const };

    await store.consume(key, opts); // entry A at t=0 → the buggy TTL would be 1000ms
    clock.advance(600);
    await store.consume(key, opts); // entry B at t=600 → the buggy TTL becomes 400ms (A's expiry)
    expect(await redis.pttl(key)).toBeGreaterThan(900); // must still cover B's whole window

    await new Promise((r) => setTimeout(r, 500)); // let a 400ms TTL elapse on the wall clock
    clock.advance(100); // t=700: both A and B are still inside the 1000ms window
    const third = await store.consume(key, opts);
    expect(third).toMatchObject({ allowed: false, count: 2 }); // B must not have vanished with A
    await redis.del(key);
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
