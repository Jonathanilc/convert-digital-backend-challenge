import { afterAll, describe, expect, it } from 'vitest';
import { expectContract, expectSchema } from '../helpers/contract.js';
import { httpClient } from '../helpers/http.js';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'admin-secret';
const [USERNAME = 'alice', PASSWORD = 'wonderland'] = (
  process.env.SMOKE_USER ?? 'alice:wonderland'
).split(':');

const VERIFY_CLIENT_IP = process.env.SMOKE_VERIFY_CLIENT_IP === 'true';

const api = httpClient(APP_URL);
const admin = { headers: { 'x-admin-token': ADMIN_TOKEN } };

/**
 * Proves a deployed instance works end to end without depending on time: the 429 path is
 * exercised through a blocking override instead of exhausting a real window.
 */
describe(`smoke against ${APP_URL}`, () => {
  const created: string[] = [];
  afterAll(async () => {
    for (const id of created) await api.delete(`/admin/overrides/${id}`, admin);
  });

  it('is healthy and connected to Redis', async () => {
    const res = await api.get('/health', { expect: 200 });
    expect(res.body).toEqual({ status: 'ok', checks: { redis: 'up' } });
    await expectContract(res, 'GET', '/health');
  });

  it('reports itself ready to receive traffic', async () => {
    const res = await api.get('/ready', { expect: 200 });
    expect(res.body).toMatchObject({ status: 'ready', checks: { redis: 'up' } });
    await expectContract(res, 'GET', '/ready');
  });

  it('serves its OpenAPI document', async () => {
    const res = await api.get('/openapi.json', { expect: 200 });
    expect(res.body.openapi).toBe('3.1.0');
  });

  it('rate limits the public API and advertises the policy', async () => {
    const res = await api.get('/api/public', { expect: 200 });
    expect(res.headers['ratelimit-limit']).toMatch(/^\d+$/);
    expect(res.headers['ratelimit-policy']).toMatch(/^\d+;w=\d+$/);
    await expectContract(res, 'GET', '/api/public');
  });

  it('authenticates with the demo credentials', async () => {
    const login = await api.post(
      '/api/login',
      { username: USERNAME, password: PASSWORD },
      { expect: 200 },
    );
    await expectContract(login, 'POST', '/api/login');
    const me = await api.get('/api/me', {
      headers: { authorization: `Bearer ${login.body.token}` },
      expect: 200,
    });
    expect(me.body).toEqual({ id: USERNAME });
    await expectContract(me, 'GET', '/api/me');
  });

  it('protects the admin API', async () => {
    await expectContract(
      await api.get('/admin/overrides', { expect: 401 }),
      'GET',
      '/admin/overrides',
    );
    await expectContract(
      await api.get('/admin/overrides', { headers: { 'x-admin-token': 'wrong' }, expect: 403 }),
      'GET',
      '/admin/overrides',
    );
  });

  it('applies and lifts a temporary override end to end', async () => {
    const createdRes = await api.post(
      '/admin/overrides',
      {
        reason: 'smoke test',
        criteria: { tiers: ['unauthenticated'], paths: ['/api/public'] },
        effect: { limit: 0 },
        ttlSeconds: 60,
      },
      { ...admin, expect: 201 },
    );
    await expectContract(createdRes, 'POST', '/admin/overrides');
    const id: string = createdRes.body.id;
    created.push(id);

    const blocked = await api.get('/api/public', { expect: 429 });
    expect(blocked.body.override).toBe(id);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    await expectContract(blocked, 'GET', '/api/public');

    const listed = await api.get('/admin/overrides', { ...admin, expect: 200 });
    expect(listed.body.overrides.map((o: { id: string }) => o.id)).toContain(id);

    await expectContract(
      await api.delete(`/admin/overrides/${id}`, { ...admin, expect: 204 }),
      'DELETE',
      '/admin/overrides/{id}',
    );
    created.splice(created.indexOf(id), 1);
    await api.get('/api/public', { expect: 200 });
  });

  it.runIf(VERIFY_CLIENT_IP)('sees the real client IP through the platform proxy', async () => {
    // Learn our own egress addresses (v4 and, if available, v6), block them, expect to be blocked.
    const lookup = async (url: string): Promise<string | undefined> => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        return res.ok ? (await res.text()).trim() : undefined;
      } catch {
        return undefined;
      }
    };
    const ips = (
      await Promise.all([lookup('https://api.ipify.org'), lookup('https://api6.ipify.org')])
    ).filter((ip): ip is string => Boolean(ip));
    expect(ips.length, 'could not determine our egress IP').toBeGreaterThan(0);

    const createdRes = await api.post(
      '/admin/overrides',
      { reason: 'smoke: client ip', criteria: { ips }, effect: { limit: 0 }, ttlSeconds: 60 },
      { ...admin, expect: 201 },
    );
    const id: string = createdRes.body.id;
    created.push(id);

    const blocked = await api.get('/api/public', { expect: 429 });
    expect(blocked.body.override).toBe(id);

    await api.delete(`/admin/overrides/${id}`, { ...admin, expect: 204 });
    created.splice(created.indexOf(id), 1);
    await api.get('/api/public', { expect: 200 });
  });

  it('answers unknown API paths with the documented error shape', async () => {
    const res = await api.get('/api/definitely-not-here', { expect: 404 });
    await expectSchema(res.body, 'Error');
  });
});
