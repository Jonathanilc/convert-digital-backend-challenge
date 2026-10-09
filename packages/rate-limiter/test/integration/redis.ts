import { Redis } from 'ioredis';

/** Integration tests run only when REDIS_URL is set (locally: `npm run redis:up`). */
export const REDIS_URL = process.env.REDIS_URL;

export function connect(): Redis {
  if (!REDIS_URL) throw new Error('REDIS_URL is not set');
  return new Redis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2_000 });
}
