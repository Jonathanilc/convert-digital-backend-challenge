import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, AppDependencies } from '../../src/demo/app.js';
import { createApp } from '../../src/demo/app.js';
import { fakeClock } from '../helpers/clock.js';
import { expectContract, expectSchema } from '../helpers/contract.js';
import { flakyRedis } from '../helpers/flaky-redis.js';
import { startServer } from '../helpers/http.js';
import { connect, deleteByPrefix, testPrefix } from '../helpers/redis.js';

const T0 = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Small limits so the suite stays fast; the shape mirrors production configuration. */
const baseConfig: AppConfig = {
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
const alice = { headers: { authorization: 'Bearer alice-token' } };
const admin = { headers: { 'x-admin-token': 'admin-secret' } };

/**
 * The whole application, served on a real port and backed by a real Redis. Only the clock,
 * the id generator and the Redis client (wrapped so outages can be simulated) are injected.
 */
describe('demo API over a real HTTP server and real Redis', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function boot(config: Partial<AppConfig> = {}, deps: Partial<AppDependencies> = {}) {
    const redis = connect();
    const flaky = flakyRedis(redis);
    const clock = fakeClock(T0);
    const prefix = testPrefix('api');
    let ids = 0;
    const app = createApp({
      config: { ...baseConfig, keyPrefix: prefix, overridesKey: `${prefix}:overrides`, ...config },
      redis: flaky.client,
      clock: clock.now,
      ids: () => `ov-${++ids}`,
      logger: silent,
      ...deps,
    });
    const running = await startServer(app);
    cleanups.push(async () => {
      await running.close();
      flaky.down = false;
      await deleteByPrefix(redis, prefix);
      await redis.quit();
    });
    return { api: running.api, clock, flaky };
  }

  describe('meta', () => {
    it('GET /health reports Redis as up', async () => {
      const { api } = await boot();
      const res = await api.get('/health', { expect: 200 });
      expect(res.body).toEqual({ status: 'ok', checks: { redis: 'up' } });
      await expectContract(res, 'GET', '/health');
    });

    it('GET /health reports degraded when Redis is unreachable', async () => {
      const { api, flaky } = await boot();
      flaky.down = true;
      const res = await api.get('/health', { expect: 200 });
      expect(res.body).toEqual({ status: 'degraded', checks: { redis: 'down' } });
      await expectContract(res, 'GET', '/health');
    });

    it('GET /openapi.json serves the contract', async () => {
      const { api } = await boot();
      const res = await api.get('/openapi.json', { expect: 200 });
      expect(res.body.openapi).toBe('3.1.0');
      expect(res.body.info.title).toBe('Rate Limiter Demo API');
      await expectContract(res, 'GET', '/openapi.json');
    });

    it('does not rate limit meta or admin routes', async () => {
      const { api } = await boot();
      for (let i = 0; i < 6; i++) {
        const health = await api.get('/health', { expect: 200 });
        expect(health.headers['ratelimit-limit']).toBeUndefined();
        const list = await api.get('/admin/overrides', { ...admin, expect: 200 });
        expect(list.headers['ratelimit-limit']).toBeUndefined();
      }
    });
  });

  describe('GET /api/public', () => {
    it('enforces the anonymous limit and documents it in headers and body', async () => {
      const { api } = await boot();
      for (let i = 0; i < 3; i++) {
        const res = await api.get('/api/public', { expect: 200 });
        expect(res.body).toEqual({ message: expect.any(String), tier: 'unauthenticated' });
        expect(res.headers).toMatchObject({
          'ratelimit-limit': '3',
          'ratelimit-remaining': String(2 - i),
          'ratelimit-policy': '3;w=60',
        });
        await expectContract(res, 'GET', '/api/public');
      }
      const blocked = await api.get('/api/public', { expect: 429 });
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
      const { api, clock } = await boot();
      for (let i = 0; i < 3; i++) await api.get('/api/public', { expect: 200 });
      await api.get('/api/public', { expect: 429 });
      clock.advance(60_000);
      await api.get('/api/public', { expect: 200 });
    });

    it('gives bearer-token callers the authenticated limit and a separate budget', async () => {
      const { api } = await boot();
      for (let i = 0; i < 5; i++) {
        const res = await api.get('/api/public', { ...alice, expect: 200 });
        expect(res.body.tier).toBe('authenticated');
        expect(res.headers['ratelimit-limit']).toBe('5');
      }
      await api.get('/api/public', { ...alice, expect: 429 });
      await api.get('/api/public', { expect: 200 });
    });

    it('rejects an invalid bearer token with 401 and still counts the request', async () => {
      const { api } = await boot();
      for (let i = 0; i < 3; i++) {
        const res = await api.get('/api/public', {
          headers: { authorization: 'Bearer nope' },
          expect: 401,
        });
        await expectContract(res, 'GET', '/api/public');
      }
      await api.get('/api/public', { expect: 429 });
    });

    it('counts requests to unknown paths under /api', async () => {
      const { api } = await boot();
      for (let i = 0; i < 3; i++) {
        const res = await api.get('/api/does-not-exist', { expect: 404 });
        await expectSchema(res.body, 'Error');
      }
      await api.get('/api/public', { expect: 429 });
    });
  });

  describe('GET /api/search', () => {
    it('validates the query against the contract', async () => {
      const { api } = await boot();
      const res = await api.get('/api/search', { expect: 400 });
      expect(res.body.details?.[0]?.path).toMatch(/q/);
      await expectContract(res, 'GET', '/api/search');
    });

    it('applies its own sliding-log limit', async () => {
      const { api, clock } = await boot();
      for (let i = 0; i < 2; i++) {
        const res = await api.get('/api/search?q=redis', { expect: 200 });
        expect(res.body).toEqual({
          query: 'redis',
          results: expect.any(Array),
          tier: 'unauthenticated',
        });
        expect(res.headers['ratelimit-policy']).toBe('2;w=10');
        await expectContract(res, 'GET', '/api/search');
      }
      const blocked = await api.get('/api/search?q=redis', { expect: 429 });
      expect(blocked.headers['retry-after']).toBe('10');
      await expectContract(blocked, 'GET', '/api/search');

      clock.advance(10_000);
      await api.get('/api/search?q=redis', { expect: 200 });
    });
  });

  describe('POST /api/login', () => {
    it('returns a token for valid credentials that works on /api/me', async () => {
      const { api } = await boot();
      const res = await api.post(
        '/api/login',
        { username: 'alice', password: 'wonderland' },
        { expect: 200 },
      );
      expect(res.body).toEqual({ token: 'alice-token', user: { id: 'alice' } });
      await expectContract(res, 'POST', '/api/login');

      const me = await api.get('/api/me', {
        headers: { authorization: `Bearer ${res.body.token}` },
        expect: 200,
      });
      expect(me.body).toEqual({ id: 'alice' });
      await expectContract(me, 'GET', '/api/me');
    });

    it('rejects wrong credentials', async () => {
      const { api } = await boot();
      const res = await api.post(
        '/api/login',
        { username: 'alice', password: 'guess' },
        { expect: 401 },
      );
      await expectContract(res, 'POST', '/api/login');
    });

    it('validates the body and still counts malformed attempts against the login limit', async () => {
      const { api } = await boot();
      for (let i = 0; i < 2; i++) {
        const res = await api.post('/api/login', { username: 'alice' }, { expect: 400 });
        expect(res.body.details?.[0]?.path).toMatch(/password/);
        await expectContract(res, 'POST', '/api/login');
      }
      const blocked = await api.post(
        '/api/login',
        { username: 'alice', password: 'wonderland' },
        { expect: 429 },
      );
      expect(blocked.body.limit).toBe(2);
      await expectContract(blocked, 'POST', '/api/login');
    });
  });

  describe('GET /api/me', () => {
    it('requires a bearer token', async () => {
      const { api } = await boot();
      await expectContract(await api.get('/api/me', { expect: 401 }), 'GET', '/api/me');
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
      const { api } = await boot();
      await expectContract(
        await api.get('/admin/overrides', { expect: 401 }),
        'GET',
        '/admin/overrides',
      );
      await expectContract(
        await api.get('/admin/overrides', { headers: { 'x-admin-token': 'nope' }, expect: 403 }),
        'GET',
        '/admin/overrides',
      );
    });

    it('creates, lists, applies and deletes an override', async () => {
      const { api } = await boot();
      const created = await api.post('/admin/overrides', vip, { ...admin, expect: 201 });
      expect(created.body).toEqual({
        id: 'ov-1',
        reason: vip.reason,
        criteria: vip.criteria,
        effect: vip.effect,
        expiresAt: iso(T0 + 3_600_000),
        createdAt: iso(T0),
      });
      await expectContract(created, 'POST', '/admin/overrides');

      const listed = await api.get('/admin/overrides', { ...admin, expect: 200 });
      expect(listed.body).toEqual({ overrides: [created.body] });
      await expectContract(listed, 'GET', '/admin/overrides');

      for (let i = 0; i < 8; i++) {
        const res = await api.get('/api/search?q=x', { ...alice, expect: 200 });
        expect(res.headers['ratelimit-limit']).toBe('8');
      }
      const blocked = await api.get('/api/search?q=x', { ...alice, expect: 429 });
      expect(blocked.body.override).toBe('ov-1');
      await expectContract(blocked, 'GET', '/api/search');

      await expectContract(
        await api.delete('/admin/overrides/ov-1', { ...admin, expect: 204 }),
        'DELETE',
        '/admin/overrides/{id}',
      );
      await expectContract(
        await api.delete('/admin/overrides/ov-1', { ...admin, expect: 404 }),
        'DELETE',
        '/admin/overrides/{id}',
      );
      expect((await api.get('/admin/overrides', { ...admin, expect: 200 })).body).toEqual({
        overrides: [],
      });
    });

    it('accepts an absolute expiry and rejects ambiguous, missing or past expiries', async () => {
      const { api } = await boot();
      const { ttlSeconds: _ttl, ...noTtl } = vip;

      const absolute = await api.post(
        '/admin/overrides',
        { ...noTtl, expiresAt: iso(T0 + 1_000) },
        { ...admin, expect: 201 },
      );
      expect(absolute.body.expiresAt).toBe(iso(T0 + 1_000));

      for (const body of [
        { ...vip, expiresAt: iso(T0 + 1_000) },
        noTtl,
        { ...noTtl, expiresAt: iso(T0 - 1) },
      ]) {
        const res = await api.post('/admin/overrides', body, { ...admin, expect: 400 });
        await expectContract(res, 'POST', '/admin/overrides');
      }
    });

    it('rejects an override without an effect', async () => {
      const { api } = await boot();
      const res = await api.post(
        '/admin/overrides',
        { ...vip, effect: {} },
        { ...admin, expect: 400 },
      );
      expect(res.body.details?.[0]?.path).toMatch(/effect/);
      await expectContract(res, 'POST', '/admin/overrides');
    });

    it('expires overrides automatically', async () => {
      const { api, clock } = await boot();
      await api.post('/admin/overrides', { ...vip, ttlSeconds: 60 }, { ...admin, expect: 201 });
      expect((await api.get('/api/search?q=x', alice)).headers['ratelimit-limit']).toBe('8');

      clock.advance(61_000);
      expect((await api.get('/admin/overrides', admin)).body).toEqual({ overrides: [] });
      expect((await api.get('/api/search?q=x', alice)).headers['ratelimit-limit']).toBe('4');
    });

    it('can block a client outright with limit 0', async () => {
      const { api } = await boot();
      await api.post(
        '/admin/overrides',
        {
          reason: 'abuse',
          criteria: { ips: ['127.0.0.1'] },
          effect: { limit: 0 },
          ttlSeconds: 600,
        },
        { ...admin, expect: 201 },
      );
      const res = await api.get('/api/public', { expect: 429 });
      expect(res.body).toMatchObject({ limit: 0, override: 'ov-1' });
      expect(res.headers['ratelimit-limit']).toBe('0');
      await expectContract(res, 'GET', '/api/public');
    });

    it('applies a global event override to everyone', async () => {
      const { api } = await boot();
      await api.post(
        '/admin/overrides',
        { reason: 'launch', criteria: {}, effect: { multiplier: 2 }, ttlSeconds: 600 },
        { ...admin, expect: 201 },
      );
      expect((await api.get('/api/public')).headers['ratelimit-limit']).toBe('6');
      expect((await api.get('/api/public', alice)).headers['ratelimit-limit']).toBe('10');
    });
  });

  describe('resilience', () => {
    it('fails open without RateLimit headers when Redis is down', async () => {
      const { api, flaky } = await boot();
      flaky.down = true;
      const res = await api.get('/api/public', { expect: 200 });
      expect(res.headers['ratelimit-limit']).toBeUndefined();
      await expectSchema(res.body, 'PublicResponse');
    });

    it('fails closed with 503 when configured', async () => {
      const { api, flaky } = await boot({ failurePolicy: 'closed' });
      flaky.down = true;
      const res = await api.get('/api/public', { expect: 503 });
      expect(res.headers['retry-after']).toBe('1');
      await expectContract(res, 'GET', '/api/public');
    });
  });

  describe('proxies', () => {
    it('separates anonymous clients by X-Forwarded-For only when trustProxy is enabled', async () => {
      const { api } = await boot({ trustProxy: true });
      const from = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });
      for (let i = 0; i < 3; i++)
        await api.get('/api/public', { ...from('198.51.100.1'), expect: 200 });
      await api.get('/api/public', { ...from('198.51.100.1'), expect: 429 });
      await api.get('/api/public', { ...from('198.51.100.2'), expect: 200 });
    });
  });
});
