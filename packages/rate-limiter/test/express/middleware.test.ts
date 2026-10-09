import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import type { RateLimiterOptions, RateLimitStore, TierLimits } from '../../src/core/types.js';
import { rateLimit, type RateLimitMiddlewareOptions } from '../../src/express/middleware.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { fakeClock } from '../helpers/clock.js';
import { startServer } from '../helpers/http.js';

const limits: TierLimits = {
  unauthenticated: { limit: 2, windowMs: 1_000 },
  authenticated: { limit: 4, windowMs: 1_000 },
};

/** Demo auth: resolves a bearer token to req.user, rejects nothing. */
const demoAuth: RequestHandler = (req, _res, next) => {
  if (req.headers.authorization === 'Bearer alice-token')
    (req as Request & { user?: unknown }).user = { id: 'alice' };
  next();
};

const echo: RequestHandler = (_req, res) => {
  res.json({ ok: true, key: res.locals.rateLimit?.key });
};

const errors: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status(500).json({ error: (err as Error).message });
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** Builds an app around the middleware and serves it on a real port. */
async function build(
  limiterOptions: Partial<RateLimiterOptions> = {},
  middleware: Partial<RateLimitMiddlewareOptions> = {},
  options: { trustProxy?: boolean; mountAt?: string } = {},
) {
  const clock = fakeClock();
  const store = new MemoryStore({ now: clock.now, sweepIntervalMs: 0 });
  const limiter = new RateLimiter({ store, limits, now: clock.now, ...limiterOptions });
  const app = express();
  if (options.trustProxy) app.set('trust proxy', true);
  app.use(demoAuth);

  const guard = rateLimit({ limiter, ...middleware });
  if (options.mountAt) {
    const router = express.Router();
    router.use(guard);
    router.get('/search', echo);
    router.get('/public', echo);
    app.use(options.mountAt, router);
  } else {
    app.use(guard);
    app.get('/api/public', echo);
    app.get('/api/search', echo);
    app.get('/health', echo);
  }
  app.use(errors);

  const running = await startServer(app);
  cleanups.push(running.close);
  return { api: running.api, clock, store, limiter };
}

const asAlice = { headers: { authorization: 'Bearer alice-token' } };
const from = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });

describe('rateLimit middleware', () => {
  it('allows requests up to the limit, then answers 429 with Retry-After and a JSON body', async () => {
    const { api } = await build();
    await api.get('/api/public', { expect: 200 });
    await api.get('/api/public', { expect: 200 });
    const res = await api.get('/api/public', { expect: 429 });

    expect(res.headers).toMatchObject({
      'ratelimit-limit': '2',
      'ratelimit-remaining': '0',
      'ratelimit-reset': '1',
      'ratelimit-policy': '2;w=1',
      'retry-after': '1',
    });
    expect(res.body).toEqual({
      error: 'Too Many Requests',
      message: expect.any(String),
      limit: 2,
      remaining: 0,
      retryAfterSeconds: 1,
    });
  });

  it('describes the remaining budget on allowed responses and recovers after the window', async () => {
    const { api, clock } = await build();
    const first = await api.get('/api/public', { expect: 200 });
    expect(first.headers).toMatchObject({
      'ratelimit-limit': '2',
      'ratelimit-remaining': '1',
      'ratelimit-reset': '1',
    });
    expect(first.headers['retry-after']).toBeUndefined();

    await api.get('/api/public', { expect: 200 });
    await api.get('/api/public', { expect: 429 });
    clock.advance(1_000);
    await api.get('/api/public', { expect: 200 });
  });

  it('gives authenticated callers their own budget and the higher limit', async () => {
    const { api } = await build();
    for (let i = 0; i < 4; i++) {
      const res = await api.get('/api/public', { ...asAlice, expect: 200 });
      expect(res.headers['ratelimit-limit']).toBe('4');
    }
    await api.get('/api/public', { ...asAlice, expect: 429 });
    // The anonymous budget from the same IP is untouched.
    await api.get('/api/public', { expect: 200 });
  });

  it('matches endpoint rules against the full path even when mounted on a router', async () => {
    const endpoints = [
      {
        id: 'search',
        path: '/api/search',
        limits: { unauthenticated: { limit: 1, windowMs: 1_000 } },
      },
    ];
    const { api } = await build({ endpoints }, {}, { mountAt: '/api' });
    const first = await api.get('/api/search', { expect: 200 });
    expect(first.body.key).toBe('rl:fw:search:ip:127.0.0.1');
    await api.get('/api/search', { expect: 429 });
    await api.get('/api/public', { expect: 200 });
  });

  it('exempts requests through skip and sends no headers for them', async () => {
    const { api } = await build({}, { skip: (req) => req.path === '/health' });
    for (let i = 0; i < 5; i++) {
      const res = await api.get('/health', { expect: 200 });
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    }
  });

  it('supports legacy header styles', async () => {
    const legacy = await build({}, { headers: 'legacy' });
    const res = await legacy.api.get('/api/public', { expect: 200 });
    expect(res.headers['x-ratelimit-limit']).toBe('2');
    expect(res.headers['ratelimit-limit']).toBeUndefined();

    const none = await build({}, { headers: 'none' });
    const quiet = await none.api.get('/api/public', { expect: 200 });
    expect(quiet.headers['x-ratelimit-limit']).toBeUndefined();
    expect(quiet.headers['ratelimit-limit']).toBeUndefined();
  });

  it('lets the caller replace the 429 response', async () => {
    const onLimited = vi.fn((_req, res, decision) => {
      res.status(429).type('text/plain').send(`slow down, retry in ${decision.retryAfterMs}ms`);
    });
    const { api } = await build({}, { onLimited });
    await api.get('/api/public');
    await api.get('/api/public');
    const res = await api.get('/api/public', { expect: 429 });
    expect(res.text).toBe('slow down, retry in 1000ms');
    expect(res.headers['retry-after']).toBe('1');
    expect(onLimited).toHaveBeenCalledOnce();
  });

  it('separates anonymous clients by forwarded IP only when the app trusts its proxy', async () => {
    const trusting = await build({}, {}, { trustProxy: true });
    await trusting.api.get('/api/public', { ...from('198.51.100.1'), expect: 200 });
    await trusting.api.get('/api/public', { ...from('198.51.100.1'), expect: 200 });
    await trusting.api.get('/api/public', { ...from('198.51.100.1'), expect: 429 });
    await trusting.api.get('/api/public', { ...from('198.51.100.2'), expect: 200 });

    const naive = await build();
    await naive.api.get('/api/public', { ...from('198.51.100.1'), expect: 200 });
    await naive.api.get('/api/public', { ...from('198.51.100.2'), expect: 200 });
    await naive.api.get('/api/public', { ...from('198.51.100.3'), expect: 429 });
  });

  const broken: RateLimitStore = {
    consume: async () => {
      throw new Error('ECONNREFUSED');
    },
    reset: async () => undefined,
  };

  it('fails open without RateLimit headers when the store is down', async () => {
    const onStoreError = vi.fn();
    const { api } = await build({ store: broken, onStoreError });
    const res = await api.get('/api/public', { expect: 200 });
    expect(res.headers['ratelimit-limit']).toBeUndefined();
    expect(onStoreError).toHaveBeenCalled();
  });

  it('fails closed with 503 and Retry-After when configured', async () => {
    const { api } = await build({ store: broken, failurePolicy: 'closed' });
    const res = await api.get('/api/public', { expect: 503 });
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toEqual({
      error: 'Service Unavailable',
      message: expect.any(String),
      retryAfterSeconds: 1,
    });
  });

  it('exposes the decision to downstream handlers via res.locals', async () => {
    const { api } = await build();
    const res = await api.get('/api/public', { expect: 200 });
    expect(res.body.key).toBe('rl:fw:default:ip:127.0.0.1');
  });

  it('forwards identify failures to the Express error handler', async () => {
    const { api } = await build(
      {},
      {
        identify: () => {
          throw new Error('no identity');
        },
      },
    );
    const res = await api.get('/api/public', { expect: 500 });
    expect(res.body).toEqual({ error: 'no identity' });
  });
});
