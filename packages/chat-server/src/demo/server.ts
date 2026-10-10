/**
 * Composition root: the only file that reads the environment and opens connections.
 */
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { DEFAULT_REDIS_OPTIONS } from '@challenge/rate-limiter';
import { Redis } from 'ioredis';
import pino from 'pino';
import { SqliteChatRepository } from '../store/sqlite-repository.js';
import { createChatServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

if (config.databaseFile !== ':memory:')
  mkdirSync(dirname(config.databaseFile), { recursive: true });
const repository = new SqliteChatRepository(config.databaseFile);
const redis = new Redis(config.redisUrl, DEFAULT_REDIS_OPTIONS);
redis.on('error', (error: Error) => logger.warn({ err: error }, 'redis connection error'));

const chat = await createChatServer({ config, redis, repository, logger });
chat.server.listen(config.port, () => {
  const { port } = chat.server.address() as AddressInfo;
  logger.info(
    {
      port,
      redis: new URL(config.redisUrl).host,
      database: config.databaseFile,
      defaultRoom: config.defaultRoom,
    },
    'chat server listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  chat
    .close()
    .then(() => redis.quit())
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
