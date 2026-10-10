import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  identifyByIp,
  rateLimit,
  RateLimiter,
  RedisStore,
  type FailurePolicy,
} from '@challenge/rate-limiter';
import express, { type Express } from 'express';
import OpenApiValidator from 'express-openapi-validator';
import type { Redis } from 'ioredis';
import pino, { type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { monotonicFactory } from 'ulid';
import { parse } from 'yaml';
import { ChatService } from '../core/service.js';
import type { Role } from '../core/types.js';
import {
  bearerAuthHandler,
  hashPassword,
  rejectInvalidCredentials,
  resolveBearerToken,
  type TokenOptions,
} from '../http/auth.js';
import { errorHandler } from '../http/errors.js';
import { createRoutes } from '../http/routes.js';
import type { ChatRepository } from '../store/repository.js';
import { ASYNCAPI_PATH } from '../ws/schemas.js';
import { attachChatSocket } from '../ws/server.js';

export const OPENAPI_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));

export interface SeedUser {
  username: string;
  password: string;
  role: Role;
}

export interface ChatConfig {
  jwtSecret: string;
  jwtTtlSeconds: number;
  /** Accounts created on first start if missing. */
  seedUsers: SeedUser[];
  /** Public room created on first start, owned by the first seeded admin. */
  defaultRoom: string;
  /** Per-user message limit (sliding log). */
  messageLimit: { limit: number; windowMs: number };
  /** Per-IP limit for /auth/* (fixed window). */
  loginLimit: { limit: number; windowMs: number };
  trustProxy: boolean | number | string;
  clientIpHeader?: string;
  validateResponses: boolean;
  keyPrefix: string;
  snapshotSize: number;
  failurePolicy?: FailurePolicy;
}

export interface ChatServerDeps {
  config: ChatConfig;
  redis: Redis;
  /** Owned by the server from here on: migrated on start, closed on close(). */
  repository: ChatRepository;
  clock?: () => number;
  ids?: () => string;
  logger?: Logger;
}

export interface ChatServer {
  app: Express;
  /** Not listening yet; the caller decides the port. WebSocket upgrades are handled on it. */
  server: Server;
  service: ChatService;
  close(): Promise<void>;
}

/** Composition of the chat server from injected dependencies. Nothing here reads the environment. */
export async function createChatServer(deps: ChatServerDeps): Promise<ChatServer> {
  const { config, redis, repository } = deps;
  const clock = deps.clock ?? Date.now;
  const ids = deps.ids ?? (() => monotonicFactory()(clock()));
  const logger = deps.logger ?? pino();
  const tokens: TokenOptions = {
    secret: config.jwtSecret,
    ttlSeconds: config.jwtTtlSeconds,
    now: clock,
  };

  await repository.migrate();

  const limits = (l: { limit: number; windowMs: number }) => ({
    unauthenticated: l,
    authenticated: l,
  });
  const messageLimiter = new RateLimiter({
    store: new RedisStore(redis, { now: clock }),
    algorithm: 'sliding-log',
    limits: limits(config.messageLimit),
    keyPrefix: `${config.keyPrefix}:msg`,
    failurePolicy: config.failurePolicy ?? 'open',
    now: clock,
    onStoreError: (error) => logger.warn({ err: error }, 'message rate limit store error'),
  });
  const authLimiter = new RateLimiter({
    store: new RedisStore(redis, { now: clock }),
    algorithm: 'fixed-window',
    limits: limits(config.loginLimit),
    keyPrefix: `${config.keyPrefix}:auth`,
    failurePolicy: config.failurePolicy ?? 'open',
    now: clock,
    onStoreError: (error) => logger.warn({ err: error }, 'auth rate limit store error'),
  });

  const service = new ChatService({
    repository,
    limiter: messageLimiter,
    clock,
    ids,
    snapshotSize: config.snapshotSize,
  });
  await seed(service, repository, config);

  const openapi = parse(readFileSync(OPENAPI_PATH, 'utf8')) as Record<string, unknown> & {
    info?: { title?: string };
  };
  const asyncapiYaml = readFileSync(ASYNCAPI_PATH, 'utf8');

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => {
        const id = req.headers['fly-request-id'] ?? req.headers['x-request-id'];
        return (Array.isArray(id) ? id[0] : id) ?? randomUUID();
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
      customLogLevel: (_req, res, error) =>
        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  app.use(resolveBearerToken(repository, tokens));
  app.use(
    rateLimit({
      limiter: authLimiter,
      identify: identifyByIp({ clientIpHeader: config.clientIpHeader }),
      skip: (req) => !req.path.startsWith('/auth/'),
    }),
  );
  app.use(rejectInvalidCredentials);
  app.use(express.json({ limit: '32kb' }));
  app.use(
    OpenApiValidator.middleware({
      apiSpec: openapi as Parameters<typeof OpenApiValidator.middleware>[0]['apiSpec'],
      validateRequests: true,
      validateResponses: config.validateResponses,
      validateSecurity: { handlers: { bearerAuth: bearerAuthHandler } },
    }),
  );
  app.use(
    createRoutes({
      service,
      repository,
      redis,
      tokens,
      openapi,
      asyncapiYaml,
      defaultRoom: config.defaultRoom,
    }),
  );
  app.use(errorHandler(logger));

  const server = createServer(app);
  const sockets = attachChatSocket(server, { service, repository, tokens, logger });

  return {
    app,
    server,
    service,
    close: async () => {
      await sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await repository.close();
    },
  };
}

/** Creates missing seed accounts and the default room; idempotent across restarts. */
async function seed(
  service: ChatService,
  repository: ChatRepository,
  config: ChatConfig,
): Promise<void> {
  for (const u of config.seedUsers) {
    if (!(await repository.findUserByUsername(u.username))) {
      await service.createUser({
        username: u.username,
        passwordHash: await hashPassword(u.password),
        role: u.role,
      });
    }
  }
  if (!(await repository.findRoomByName(config.defaultRoom))) {
    const ownerName = (config.seedUsers.find((u) => u.role === 'admin') ?? config.seedUsers[0])
      ?.username;
    const owner = ownerName ? await repository.findUserByUsername(ownerName) : undefined;
    if (owner) await service.createRoom(owner, { name: config.defaultRoom, visibility: 'public' });
  }
}
