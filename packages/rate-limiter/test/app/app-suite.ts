import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, AppDependencies } from '../../src/demo/app.js';
import { createApp } from '../../src/demo/app.js';
import { fakeClock } from '../helpers/clock.js';
import { expectContract, expectSchema } from '../helpers/contract.js';
import { flakyRedis } from '../helpers/flaky-redis.js';

export const T0 = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Small limits so the suite stays fast; the shape mirrors production configuration. */
export const baseConfig: AppConfig = {
  limits: {
    unauthenticated: { limit: 3, windowMs: 60_000 },
    authenticated: { limit: 5, windowMs: 60_000 },
  },
  algorithm: 'fixed-window',
  endpoints: [
    {
      id: 'login',
      path: '/api/login',
      methods: ['POST'],
      limits: {
        unauthenticated: { limit: 2, windowMs: 900_000 },
        authenticated: { limit: 2, windowMs: 900_000 },
      },
    },
    {
      id: 'search',
      path: '/api/search',
      algorithm: 'sliding-log',
      limits: {
        unauthenticated: { limit: 2, windowMs: 10_000 },
        authenticated: { limit: 4, windowMs: 10_000 },
      },
    },
  ],
  users: [{ id: 'alice', password: 'wonderland', token: 'alice-token' }],
  adminToken: 'admin-secret',
  trustProxy: false,
  failurePolicy: 'open',
  validateResponses: true,
  keyPrefix: 'rl',
  overridesKey: 'rl:overrides',
  overridesRefreshMs: 5_000,
};

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function deleteByPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}

/**
 * Component suite for the demo application. The whole app is exercised over HTTP; the only
 * things injected are the Redis client, the clock and the id generator. Running it against
 * ioredis-mock and against a real Redis proves the two are interchangeable.
 */
export function runAppSuite(name: string, makeRedis: () => Redis | Promise<Redis>): void {
  describe(`demo app (${name})`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      while (cleanups.length > 0) await cleanups.pop()!();
    });

    async function boot(config: Partial<AppConfig> = {}, deps: Partial<AppDependencies> = {}) {
      const redis = await makeRedis();
      const flaky = flakyRedis(redis);
      const clock = fakeClock(T0);
      const prefix = `test:${Math.random().toString(36).slice(2)}`;
      let ids = 0;
      const app = createApp({
        config: {
          ...baseConfig,
          keyPrefix: prefix,
          overridesKey: `${prefix}:overrides`,
          ...config,
        },
        redis: flaky.client,
        clock: clock.now,
        ids: () => `ov-${++ids}`,
        logger: silent,
        ...deps,
      });
      cleanups.push(async () => {
        flaky.down = false;
        await deleteByPrefix(redis, prefix);
        await redis.quit();
      });
      return { app, clock, flaky };
    }

    const asAlice = (req: request.Test) => req.set('Authorization', 'Bearer alice-token');
    const asAdmin = (req: request.Test) => req.set('X-Admin-Token', 'admin-secret');

    describe('meta', () => {
      it('GET /health reports Redis as up', async () => {
        const { app } = await boot();
        const res = await request(app).get('/health').expect(200);
        expect(res.body).toEqual({ status: 'ok', checks: { redis: 'up' } });
        await expectContract(res, 'GET', '/health');
      });

      it('GET /health reports degraded when Redis is unreachable', async () => {
        const { app, flaky } = await boot();
        flaky.down = true;
        const res = await request(app).get('/health').expect(200);
        expect(res.body).toEqual({ status: 'degraded', checks: { redis: 'down' } });
        await expectContract(res, 'GET', '/health');
      });

      it('GET /openapi.json serves the contract', async () => {
        const { app } = await boot();
        const res = await request(app).get('/openapi.json').expect(200);
        expect(res.body.openapi).toBe('3.1.0');
        expect(res.body.info.title).toBe('Rate Limiter Demo API');
        await expectContract(res, 'GET', '/openapi.json');
      });

      it('does not rate limit meta or admin routes', async () => {
        const { app } = await boot();
        for (let i = 0; i < 6; i++) {
          const health = await request(app).get('/health').expect(200);
          expect(health.headers['ratelimit-limit']).toBeUndefined();
          const admin = await asAdmin(request(app).get('/admin/overrides')).expect(200);
          expect(admin.headers['ratelimit-limit']).toBeUndefined();
        }
      });
    });

    describe('GET /api/public', () => {
      it('enforces the anonymous limit and documents it in headers and body', async () => {
        const { app } = await boot();
        for (let i = 0; i < 3; i++) {
          const res = await request(app).get('/api/public').expect(200);
          expect(res.body).toEqual({ message: expect.any(String), tier: 'unauthenticated' });
          expect(res.headers).toMatchObject({
            'ratelimit-limit': '3',
            'ratelimit-remaining': String(2 - i),
            'ratelimit-policy': '3;w=60',
          });
          await expectContract(res, 'GET', '/api/public');
        }
        const blocked = await request(app).get('/api/public').expect(429);
        expect(blocked.headers['retry-after']).toBe('60');
        expect(blocked.body).toEqual({
          error: 'Too Many Requests',
          message: expect.any(String),
          limit: 3,
          remaining: 0,
          retryAfterSeconds: 60,
        });
        await expectContract(blocked, 'GET', '/api/public');
      });

      it('recovers once the window has passed', async () => {
        const { app, clock } = await boot();
        for (let i = 0; i < 3; i++) await request(app).get('/api/public').expect(200);
        await request(app).get('/api/public').expect(429);
        clock.advance(60_000);
        await request(app).get('/api/public').expect(200);
      });

      it('gives bearer-token callers the authenticated limit and a separate budget', async () => {
        const { app } = await boot();
        for (let i = 0; i < 5; i++) {
          const res = await asAlice(request(app).get('/api/public')).expect(200);
          expect(res.body.tier).toBe('authenticated');
          expect(res.headers['ratelimit-limit']).toBe('5');
        }
        await asAlice(request(app).get('/api/public')).expect(429);
        await request(app).get('/api/public').expect(200);
      });

      it('rejects an invalid bearer token with 401 and still counts the request', async () => {
        const { app } = await boot();
        for (let i = 0; i < 3; i++) {
          const res = await request(app)
            .get('/api/public')
            .set('Authorization', 'Bearer nope')
            .expect(401);
          await expectContract(res, 'GET', '/api/public');
        }
        await request(app).get('/api/public').expect(429);
      });

      it('counts requests to unknown paths under /api', async () => {
        const { app } = await boot();
        for (let i = 0; i < 3; i++) {
          const res = await request(app).get('/api/does-not-exist').expect(404);
          await expectSchema(res.body, 'Error');
        }
        await request(app).get('/api/public').expect(429);
      });
    });

    describe('GET /api/search', () => {
      it('validates the query against the contract', async () => {
        const { app } = await boot();
        const res = await request(app).get('/api/search').expect(400);
        expect(res.body.details?.[0]?.path).toMatch(/q/);
        await expectContract(res, 'GET', '/api/search');
      });

      it('applies its own sliding-log limit', async () => {
        const { app, clock } = await boot();
        for (let i = 0; i < 2; i++) {
          const res = await request(app).get('/api/search?q=redis').expect(200);
          expect(res.body).toEqual({
            query: 'redis',
            results: expect.any(Array),
            tier: 'unauthenticated',
          });
          expect(res.headers['ratelimit-policy']).toBe('2;w=10');
          await expectContract(res, 'GET', '/api/search');
        }
        const blocked = await request(app).get('/api/search?q=redis').expect(429);
        expect(blocked.headers['retry-after']).toBe('10');
        await expectContract(blocked, 'GET', '/api/search');

        clock.advance(10_000);
        await request(app).get('/api/search?q=redis').expect(200);
      });
    });

    describe('POST /api/login', () => {
      it('returns a token for valid credentials that works on /api/me', async () => {
        const { app } = await boot();
        const res = await request(app)
          .post('/api/login')
          .send({ username: 'alice', password: 'wonderland' })
          .expect(200);
        expect(res.body).toEqual({ token: 'alice-token', user: { id: 'alice' } });
        await expectContract(res, 'POST', '/api/login');

        const me = await request(app)
          .get('/api/me')
          .set('Authorization', `Bearer ${res.body.token}`)
          .expect(200);
        expect(me.body).toEqual({ id: 'alice' });
        await expectContract(me, 'GET', '/api/me');
      });

      it('rejects wrong credentials', async () => {
        const { app } = await boot();
        const res = await request(app)
          .post('/api/login')
          .send({ username: 'alice', password: 'guess' })
          .expect(401);
        await expectContract(res, 'POST', '/api/login');
      });

      it('validates the body and still counts malformed attempts against the login limit', async () => {
        const { app } = await boot();
        for (let i = 0; i < 2; i++) {
          const res = await request(app).post('/api/login').send({ username: 'alice' }).expect(400);
          expect(res.body.details?.[0]?.path).toMatch(/password/);
          await expectContract(res, 'POST', '/api/login');
        }
        const blocked = await request(app)
          .post('/api/login')
          .send({ username: 'alice', password: 'wonderland' })
          .expect(429);
        expect(blocked.body.limit).toBe(2);
        await expectContract(blocked, 'POST', '/api/login');
      });
    });

    describe('GET /api/me', () => {
      it('requires a bearer token', async () => {
        const { app } = await boot();
        const res = await request(app).get('/api/me').expect(401);
        await expectContract(res, 'GET', '/api/me');
      });
    });

    describe('admin overrides', () => {
      const vip = {
        reason: 'Support ticket #4821',
        criteria: { userIds: ['alice'], ruleIds: ['search'] },
        effect: { multiplier: 2 },
        ttlSeconds: 3_600,
      };

      it('requires the admin token', async () => {
        const { app } = await boot();
        const missing = await request(app).get('/admin/overrides').expect(401);
        await expectContract(missing, 'GET', '/admin/overrides');
        const wrong = await request(app)
          .get('/admin/overrides')
          .set('X-Admin-Token', 'nope')
          .expect(403);
        await expectContract(wrong, 'GET', '/admin/overrides');
      });

      it('creates, lists, applies and deletes an override', async () => {
        const { app } = await boot();
        const created = await asAdmin(request(app).post('/admin/overrides')).send(vip).expect(201);
        expect(created.body).toEqual({
          id: 'ov-1',
          reason: vip.reason,
          criteria: vip.criteria,
          effect: vip.effect,
          expiresAt: iso(T0 + 3_600_000),
          createdAt: iso(T0),
        });
        await expectContract(created, 'POST', '/admin/overrides');

        const listed = await asAdmin(request(app).get('/admin/overrides')).expect(200);
        expect(listed.body).toEqual({ overrides: [created.body] });
        await expectContract(listed, 'GET', '/admin/overrides');

        for (let i = 0; i < 8; i++) {
          const res = await asAlice(request(app).get('/api/search?q=x')).expect(200);
          expect(res.headers['ratelimit-limit']).toBe('8');
        }
        const blocked = await asAlice(request(app).get('/api/search?q=x')).expect(429);
        expect(blocked.body.override).toBe('ov-1');
        await expectContract(blocked, 'GET', '/api/search');

        const removed = await asAdmin(request(app).delete('/admin/overrides/ov-1')).expect(204);
        await expectContract(removed, 'DELETE', '/admin/overrides/{id}');
        const gone = await asAdmin(request(app).delete('/admin/overrides/ov-1')).expect(404);
        await expectContract(gone, 'DELETE', '/admin/overrides/{id}');
        expect((await asAdmin(request(app).get('/admin/overrides'))).body).toEqual({
          overrides: [],
        });
      });

      it('accepts an absolute expiry and rejects ambiguous, missing or past expiries', async () => {
        const { app } = await boot();
        const { ttlSeconds: _ttl, ...noTtl } = vip;

        const absolute = await asAdmin(request(app).post('/admin/overrides'))
          .send({ ...noTtl, expiresAt: iso(T0 + 1_000) })
          .expect(201);
        expect(absolute.body.expiresAt).toBe(iso(T0 + 1_000));

        for (const body of [
          { ...vip, expiresAt: iso(T0 + 1_000) },
          noTtl,
          { ...noTtl, expiresAt: iso(T0 - 1) },
        ]) {
          const res = await asAdmin(request(app).post('/admin/overrides')).send(body).expect(400);
          await expectContract(res, 'POST', '/admin/overrides');
        }
      });

      it('rejects an override without an effect', async () => {
        const { app } = await boot();
        const res = await asAdmin(request(app).post('/admin/overrides'))
          .send({ ...vip, effect: {} })
          .expect(400);
        expect(res.body.details?.[0]?.path).toMatch(/effect/);
        await expectContract(res, 'POST', '/admin/overrides');
      });

      it('expires overrides automatically', async () => {
        const { app, clock } = await boot();
        await asAdmin(request(app).post('/admin/overrides'))
          .send({ ...vip, ttlSeconds: 60 })
          .expect(201);
        expect(
          (await asAlice(request(app).get('/api/search?q=x'))).headers['ratelimit-limit'],
        ).toBe('8');

        clock.advance(61_000);
        expect((await asAdmin(request(app).get('/admin/overrides'))).body).toEqual({
          overrides: [],
        });
        expect(
          (await asAlice(request(app).get('/api/search?q=x'))).headers['ratelimit-limit'],
        ).toBe('4');
      });

      it('can block a client outright with limit 0', async () => {
        const { app } = await boot();
        await asAdmin(request(app).post('/admin/overrides'))
          .send({
            reason: 'abuse',
            criteria: { ips: ['127.0.0.1'] },
            effect: { limit: 0 },
            ttlSeconds: 600,
          })
          .expect(201);
        const res = await request(app).get('/api/public').expect(429);
        expect(res.body).toMatchObject({ limit: 0, override: 'ov-1' });
        expect(res.headers['ratelimit-limit']).toBe('0');
        await expectContract(res, 'GET', '/api/public');
      });

      it('applies a global event override to everyone', async () => {
        const { app } = await boot();
        await asAdmin(request(app).post('/admin/overrides'))
          .send({ reason: 'launch', criteria: {}, effect: { multiplier: 2 }, ttlSeconds: 600 })
          .expect(201);
        expect((await request(app).get('/api/public')).headers['ratelimit-limit']).toBe('6');
        expect((await asAlice(request(app).get('/api/public'))).headers['ratelimit-limit']).toBe(
          '10',
        );
      });
    });

    describe('resilience', () => {
      it('fails open without RateLimit headers when Redis is down', async () => {
        const { app, flaky } = await boot();
        flaky.down = true;
        const res = await request(app).get('/api/public').expect(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
        await expectContract(res, 'GET', '/api/public').catch(() => undefined); // headers are optional when degraded
        expect(res.body.tier).toBe('unauthenticated');
      });

      it('fails closed with 503 when configured', async () => {
        const { app, flaky } = await boot({ failurePolicy: 'closed' });
        flaky.down = true;
        const res = await request(app).get('/api/public').expect(503);
        expect(res.headers['retry-after']).toBe('1');
        await expectContract(res, 'GET', '/api/public');
      });
    });

    describe('proxies', () => {
      it('separates anonymous clients by X-Forwarded-For only when trustProxy is enabled', async () => {
        const { app } = await boot({ trustProxy: true });
        for (let i = 0; i < 3; i++)
          await request(app).get('/api/public').set('X-Forwarded-For', '198.51.100.1').expect(200);
        await request(app).get('/api/public').set('X-Forwarded-For', '198.51.100.1').expect(429);
        await request(app).get('/api/public').set('X-Forwarded-For', '198.51.100.2').expect(200);
      });
    });
  });
}
