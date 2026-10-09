import type { Redis } from 'ioredis';
import { afterAll, describe } from 'vitest';
import { RedisStore } from '../../src/stores/redis-store.js';
import { runStoreContract } from '../stores/store-contract.js';
import { connect, REDIS_URL } from './redis.js';

describe.skipIf(!REDIS_URL)('integration', () => {
  const clients: Redis[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
  });

  runStoreContract('RedisStore (real Redis)', (clock) => {
    const client = connect();
    clients.push(client);
    return new RedisStore(client, { now: clock.now });
  });
});
