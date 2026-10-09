import { describe, expect, it } from 'vitest';
import { assertRedisReachable, connect, deleteByPrefix, REDIS_URL, testPrefix } from './redis.js';

describe('real-Redis test helper', () => {
  it('fails fast with an actionable hint when Redis is unreachable', async () => {
    await expect(assertRedisReachable('redis://127.0.0.1:1')).rejects.toThrow(/npm run redis:up/);
  });

  it('is satisfied by the configured server', async () => {
    await expect(assertRedisReachable(REDIS_URL)).resolves.toBeUndefined();
  });

  it('deletes only keys under the given prefix', async () => {
    const redis = connect();
    const mine = testPrefix('cleanup');
    const other = testPrefix('cleanup-other');
    await redis.mset(`${mine}:a`, '1', `${mine}:b`, '2', `${other}:a`, '3');
    expect(await deleteByPrefix(redis, mine)).toBe(2);
    expect(await redis.exists(`${other}:a`)).toBe(1);
    await redis.del(`${other}:a`);
    await redis.quit();
  });
});
