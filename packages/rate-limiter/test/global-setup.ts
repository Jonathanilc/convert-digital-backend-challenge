import { assertRedisReachable, connect, deleteByPrefix } from './helpers/redis.js';

/** Runs once per Vitest invocation: verify Redis, then clear leftovers from aborted runs. */
export default async function setup(): Promise<void> {
  await assertRedisReachable();
  const redis = connect();
  try {
    await deleteByPrefix(redis, 'test:');
  } finally {
    await redis.quit();
  }
}
