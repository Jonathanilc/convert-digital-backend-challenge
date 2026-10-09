/**
 * Composition root. This is the only file that touches the environment and creates real
 * connections; everything else receives its dependencies through `createApp`.
 */
import { Redis } from 'ioredis';
import pino from 'pino';
import { DEFAULT_REDIS_OPTIONS } from '../stores/redis-store.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/** Host part only; the Redis URL carries a password. */
const redisHost = new URL(config.redisUrl).host;

const redis = new Redis(config.redisUrl, DEFAULT_REDIS_OPTIONS);
redis.on('error', (error: Error) => logger.warn({ err: error }, 'redis connection error'));

const app = createApp({ config, redis, logger });
const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      redis: redisHost,
      algorithm: config.algorithm,
      failurePolicy: config.failurePolicy,
    },
    'rate-limiter demo listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
