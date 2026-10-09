import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import OpenApiValidator from 'express-openapi-validator';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { RateLimiter } from '../core/rate-limiter.js';
import type { Algorithm, EndpointRule, FailurePolicy, TierLimits } from '../core/types.js';
import { identifyByUserOrIp } from '../express/identify.js';
import { rateLimit } from '../express/middleware.js';
import { RedisOverrideStore } from '../overrides/redis-override-store.js';
import { RedisStore } from '../stores/redis-store.js';
import { adminRouter } from './admin.js';
import { swaggerUiPage } from './docs.js';
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
  /**
   * Header set by the hosting platform with the real client address (e.g. `Fly-Client-IP`).
   * Preferred over `trust proxy` hop counting when available.
   */
  clientIpHeader?: string;
  failurePolicy: FailurePolicy;
  /** Validate responses against the contract (test/dev only; costs latency). */
  validateResponses: boolean;
  keyPrefix: string;
  overridesKey: string;
  overridesRefreshMs: number;
}

/**
 * Everything the application needs from the outside world. `server.ts` builds these from
 * the environment; tests inject a real Redis client (wrapped so outages can be simulated),
 * a fake clock and a deterministic id generator, then drive the app over a real HTTP port.
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
  logger = pino(),
}: AppDependencies): Express {
  const store = new RedisStore(redis, { now: clock });
  const overrides = new RedisOverrideStore(redis, {
    key: config.overridesKey,
    refreshMs: config.overridesRefreshMs,
    now: clock,
    onError: (error) => logger.warn({ err: error }, 'override refresh failed'),
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
    onStoreError: (error) => logger.warn({ err: error }, 'rate limit store error'),
  });

  const spec = loadOpenApiDocument();
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // 0. One structured log line per request (probes excluded), with the rate-limit decision.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => {
        const platformId = req.headers['fly-request-id'] ?? req.headers['x-request-id'];
        return (Array.isArray(platformId) ? platformId[0] : platformId) ?? randomUUID();
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
      customLogLevel: (_req, res, error) =>
        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      customProps: (_req, res) => {
        const decision = res.locals.rateLimit;
        return decision
          ? {
              rateLimit: {
                ruleId: decision.ruleId,
                tier: decision.tier,
                allowed: decision.allowed,
                remaining: decision.remaining,
                ...(decision.override ? { override: decision.override.id } : {}),
                ...(decision.degraded ? { degraded: true } : {}),
              },
            }
          : {};
      },
    }),
  );

  // 1. Resolve credentials (never rejects, so the limiter sees every request).
  app.use(resolveBearerToken(config.users));

  // 2. Rate limit everything under /api before any parsing or validation happens.
  app.use(
    rateLimit({
      limiter,
      identify: identifyByUserOrIp({ clientIpHeader: config.clientIpHeader }),
      skip: (req) => !req.path.startsWith(RATE_LIMITED_PREFIX),
    }),
  );

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

  // Readiness for load balancers and rolling deploys. A Redis outage only makes the instance
  // not-ready when the failure policy is closed; when failing open it can still serve.
  app.get('/ready', async (_req, res) => {
    let redisStatus: Schemas['Readiness']['checks']['redis'] = 'up';
    try {
      await redis.ping();
    } catch {
      redisStatus = 'down';
    }
    const ready = redisStatus === 'up' || config.failurePolicy === 'open';
    const body: Schemas['Readiness'] = {
      status: ready ? 'ready' : 'not-ready',
      checks: { redis: redisStatus },
      failurePolicy: config.failurePolicy,
    };
    res.status(ready ? 200 : 503).json(body);
  });

  const docsPage = swaggerUiPage(
    '/openapi.json',
    String((spec.info as { title?: string } | undefined)?.title ?? 'API'),
  );
  app.get('/docs', (_req, res) => {
    res.type('html').send(docsPage);
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
