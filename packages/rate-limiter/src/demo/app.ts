import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import OpenApiValidator from 'express-openapi-validator';
import type { Redis } from 'ioredis';
import { RateLimiter } from '../core/rate-limiter.js';
import type { Algorithm, EndpointRule, FailurePolicy, TierLimits } from '../core/types.js';
import { rateLimit } from '../express/middleware.js';
import { RedisOverrideStore } from '../overrides/redis-override-store.js';
import { RedisStore } from '../stores/redis-store.js';
import { adminRouter } from './admin.js';
import {
  adminTokenHandler,
  authenticate,
  bearerAuthHandler,
  rejectInvalidCredentials,
  resolveBearerToken,
  type DemoUser,
} from './auth.js';
import { errorHandler, sendError, type Logger } from './errors.js';
import type { components } from './generated/openapi.js';
import { loadOpenApiDocument } from './openapi.js';

type Schemas = components['schemas'];

export interface AppConfig {
  limits: TierLimits;
  algorithm: Algorithm;
  endpoints: EndpointRule[];
  users: DemoUser[];
  adminToken: string;
  /** Express `trust proxy` setting. */
  trustProxy: boolean | number | string;
  failurePolicy: FailurePolicy;
  /** Validate responses against the contract (test/dev only; costs latency). */
  validateResponses: boolean;
  keyPrefix: string;
  overridesKey: string;
  overridesRefreshMs: number;
}

/**
 * Everything the application needs from the outside world. `server.ts` builds these from
 * the environment; tests build them from an `ioredis-mock` client and a fake clock.
 */
export interface AppDependencies {
  config: AppConfig;
  redis: Redis;
  clock?: () => number;
  /** Generates override ids. Defaults to `randomUUID`. */
  ids?: () => string;
  logger?: Logger;
}

const RATE_LIMITED_PREFIX = '/api';

export function createApp({
  config,
  redis,
  clock = Date.now,
  ids = randomUUID,
  logger = console,
}: AppDependencies): Express {
  const store = new RedisStore(redis, { now: clock });
  const overrides = new RedisOverrideStore(redis, {
    key: config.overridesKey,
    refreshMs: config.overridesRefreshMs,
    now: clock,
    onError: (error) => logger.warn('override refresh failed', error),
  });
  const limiter = new RateLimiter({
    store,
    overrides,
    limits: config.limits,
    algorithm: config.algorithm,
    endpoints: config.endpoints,
    keyPrefix: config.keyPrefix,
    failurePolicy: config.failurePolicy,
    now: clock,
    onStoreError: (error) => logger.warn('rate limit store error', error),
  });

  const spec = loadOpenApiDocument();
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // 1. Resolve credentials (never rejects, so the limiter sees every request).
  app.use(resolveBearerToken(config.users));

  // 2. Rate limit everything under /api before any parsing or validation happens.
  app.use(rateLimit({ limiter, skip: (req) => !req.path.startsWith(RATE_LIMITED_PREFIX) }));

  // 3. Now reject presented-but-invalid credentials.
  app.use(rejectInvalidCredentials);

  // 4. Parse and validate against the contract; enforce its security requirements.
  app.use(express.json({ limit: '16kb' }));
  app.use(
    OpenApiValidator.middleware({
      apiSpec: spec as Parameters<typeof OpenApiValidator.middleware>[0]['apiSpec'],
      validateRequests: true,
      validateResponses: config.validateResponses,
      validateSecurity: {
        handlers: {
          bearerAuth: bearerAuthHandler,
          adminToken: adminTokenHandler(config.adminToken),
        },
      },
    }),
  );

  // 5. Routes.
  app.get('/health', async (_req, res) => {
    let redisStatus: Schemas['Health']['checks']['redis'] = 'up';
    try {
      await redis.ping();
    } catch {
      redisStatus = 'down';
    }
    const body: Schemas['Health'] = {
      status: redisStatus === 'up' ? 'ok' : 'degraded',
      checks: { redis: redisStatus },
    };
    res.json(body);
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });

  app.get('/api/public', (_req, res) => {
    const body: Schemas['PublicResponse'] = {
      message: 'Hello from the rate-limited API.',
      tier: res.locals.rateLimit?.tier ?? 'unauthenticated',
    };
    res.json(body);
  });

  app.get('/api/search', (req, res) => {
    const query = String(req.query.q);
    const body: Schemas['SearchResponse'] = {
      query,
      results: [1, 2, 3].map((n) => `${query} result ${n}`),
      tier: res.locals.rateLimit?.tier ?? 'unauthenticated',
    };
    res.json(body);
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body as Schemas['LoginRequest'];
    const user = authenticate(config.users, username, password);
    if (!user) {
      sendError(res, 401, 'Invalid username or password');
      return;
    }
    const body: Schemas['LoginResponse'] = { token: user.token, user: { id: user.id } };
    res.json(body);
  });

  app.get('/api/me', (req, res) => {
    const body: Schemas['User'] = { id: req.user!.id };
    res.json(body);
  });

  app.use('/admin/overrides', adminRouter({ overrides, clock, ids }));

  // 6. One error handler that speaks the contract's Error schema.
  app.use(errorHandler(logger));

  return app;
}
