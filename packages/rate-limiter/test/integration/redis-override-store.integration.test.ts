import type { Redis } from 'ioredis';
import { afterAll, describe } from 'vitest';
import { RedisOverrideStore } from '../../src/overrides/redis-override-store.js';
import { runOverrideStoreContract } from '../overrides/override-store-contract.js';
import { connect, REDIS_URL } from './redis.js';

describe.skipIf(!REDIS_URL)('integration', () => {
  const clients: Redis[] = [];
  const keys: string[] = [];
  afterAll(async () => {
    const client = clients[0];
    if (client && keys.length > 0) await client.del(...keys);
    await Promise.all(clients.map((c) => c.quit()));
  });

  runOverrideStoreContract('RedisOverrideStore (real Redis)', (clock) => {
    const client = connect();
    clients.push(client);
    const key = `test:overrides:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    keys.push(key);
    return new RedisOverrideStore(client, { key, now: clock.now });
  });
});
