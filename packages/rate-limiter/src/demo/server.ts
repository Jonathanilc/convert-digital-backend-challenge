/**
 * Composition root. This is the only file that touches the environment and creates real
 * connections; everything else receives its dependencies through `createApp`.
 */
import { Redis } from 'ioredis';
import { DEFAULT_REDIS_OPTIONS } from '../stores/redis-store.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const logger = console;
const config = loadConfig(process.env);

const redis = new Redis(config.redisUrl, DEFAULT_REDIS_OPTIONS);
redis.on('error', (error: Error) => logger.warn(`[redis] ${error.message}`));

const app = createApp({ config, redis, logger });
const server = app.listen(config.port, () => {
  logger.info(
    `rate-limiter demo listening on http://localhost:${config.port} ` +
      `(redis ${config.redisUrl}, default algorithm ${config.algorithm}, fail-${config.failurePolicy})`,
  );
});

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
