import RedisMock from 'ioredis-mock';
import { describe, expect, it, vi } from 'vitest';
import { RedisOverrideStore } from '../../src/overrides/redis-override-store.js';
import { fakeClock } from '../helpers/clock.js';
import { ctx, makeOverride, T0 } from './fixtures.js';
import { runOverrideStoreContract } from './override-store-contract.js';

const KEY = 'test:overrides';

runOverrideStoreContract('RedisOverrideStore (ioredis-mock)', (clock) => {
  const redis = new RedisMock();
  return new RedisOverrideStore(redis, { key: `${KEY}:${Math.random()}`, now: clock.now });
});

describe('RedisOverrideStore: multi-instance behaviour', () => {
  function pair(refreshMs = 5_000) {
    const redis = new RedisMock();
    const clock = fakeClock(T0);
    const key = `${KEY}:${Math.random()}`;
    const onError = vi.fn();
    const a = new RedisOverrideStore(redis, { key, now: clock.now, refreshMs, onError });
    const b = new RedisOverrideStore(redis, { key, now: clock.now, refreshMs, onError });
    return { redis, clock, key, a, b, onError };
  }

  it('serves resolve from a local snapshot that another instance sees within one refresh interval', async () => {
    const { clock, a, b } = pair(5_000);
    expect(await b.resolve(ctx())).toBeUndefined(); // first call loads the (empty) snapshot

    await a.put(makeOverride({ id: 'event' }));
    expect(await b.resolve(ctx())).toBeUndefined(); // still inside the refresh interval

    clock.advance(5_000);
    await b.resolve(ctx({ now: clock.now() })); // stale answer, refresh kicked off in the background
    await vi.waitFor(async () =>
      expect((await b.resolve(ctx({ now: clock.now() })))?.id).toBe('event'),
    );
  });

  it('sees its own writes immediately', async () => {
    const { a } = pair();
    await a.resolve(ctx());
    await a.put(makeOverride({ id: 'mine' }));
    expect((await a.resolve(ctx()))?.id).toBe('mine');
    await a.remove('mine');
    expect(await a.resolve(ctx())).toBeUndefined();
  });

  it('removes expired entries from Redis when it refreshes', async () => {
    const { redis, clock, key, a } = pair();
    await a.put(makeOverride({ id: 'short', expiresAt: T0 + 100 }));
    await a.put(makeOverride({ id: 'long', expiresAt: T0 + 100_000 }));
    expect(await redis.hlen(key)).toBe(2);

    clock.advance(200);
    await a.refresh();
    await vi.waitFor(async () => expect(await redis.hlen(key)).toBe(1));
    expect((await a.list()).map((o) => o.id)).toEqual(['long']);
  });

  it('ignores and removes corrupt entries', async () => {
    const { redis, key, a } = pair();
    await redis.hset(key, 'broken', '{not json');
    await a.put(makeOverride({ id: 'ok' }));
    await a.refresh();
    expect((await a.list()).map((o) => o.id)).toEqual(['ok']);
    await vi.waitFor(async () => expect(await redis.hexists(key, 'broken')).toBe(0));
  });

  it('keeps serving the last good snapshot when a refresh fails', async () => {
    const { redis, clock, a, onError } = pair(1_000);
    await a.put(makeOverride({ id: 'event' }));
    await a.refresh();
    expect((await a.resolve(ctx()))?.id).toBe('event');

    vi.spyOn(redis, 'hgetall').mockRejectedValue(new Error('redis down'));
    clock.advance(1_000);
    expect((await a.resolve(ctx({ now: clock.now() })))?.id).toBe('event');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    expect((await a.resolve(ctx({ now: clock.now() })))?.id).toBe('event');
  });

  it('does not close a client it was given', async () => {
    const redis = new RedisMock();
    const quit = vi.spyOn(redis, 'quit');
    await new RedisOverrideStore(redis).close();
    expect(quit).not.toHaveBeenCalled();
  });
});
