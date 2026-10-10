import { Redis } from 'ioredis';

/** Every Redis-touching test runs against a real server. Host default; compose sets redis://redis:6379. */
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function redisHint(url: string): string {
  return (
    `Tests need a real Redis at ${url}. ` +
    'Run "make test" (inside Docker) or start one with "make redis" and run "npm test" here.'
  );
}

export function connect(url = REDIS_URL): Redis {
  return new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 2_000 });
}

/** Fails fast with an actionable message instead of letting every suite time out individually. */
export async function assertRedisReachable(url = REDIS_URL): Promise<void> {
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    throw new Error(`${redisHint(url)}\nCause: ${(error as Error).message}`);
  } finally {
    client.disconnect();
  }
}

export async function deleteByPrefix(redis: Redis, prefix: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    if (keys.length > 0) deleted += await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
  return deleted;
}

let counter = 0;
/** Unique key prefix per test so parallel Vitest workers never collide on the shared server. */
export function testPrefix(label = 't'): string {
  return `test:${label}:${process.pid}:${Date.now()}:${counter++}`;
}
