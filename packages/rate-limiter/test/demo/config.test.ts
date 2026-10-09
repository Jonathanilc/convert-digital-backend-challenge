import { describe, expect, it } from 'vitest';
import { DEMO_ENDPOINTS, loadConfig } from '../../src/demo/config.js';

describe('loadConfig', () => {
  it('provides sensible defaults for local development', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 3000,
      redisUrl: 'redis://localhost:6379',
      algorithm: 'fixed-window',
      limits: {
        unauthenticated: { limit: 100, windowMs: 3_600_000 },
        authenticated: { limit: 200, windowMs: 3_600_000 },
      },
      adminToken: 'admin-secret',
      trustProxy: false,
      failurePolicy: 'open',
      validateResponses: true,
      keyPrefix: 'rl',
      overridesKey: 'rl:overrides',
      overridesRefreshMs: 5_000,
    });
    expect(config.users.map((u) => u.id)).toEqual(['alice', 'bob']);
    expect(config.endpoints).toBe(DEMO_ENDPOINTS);
    expect(config.endpoints.map((e) => e.id)).toEqual(['login', 'search']);
  });

  it('reads every setting from the environment', () => {
    const config = loadConfig({
      PORT: '8080',
      REDIS_URL: 'redis://cache:6380/2',
      RATE_LIMIT_ALGORITHM: 'sliding-log',
      UNAUTH_LIMIT: '10',
      UNAUTH_WINDOW_MS: '60000',
      AUTH_LIMIT: '20',
      AUTH_WINDOW_MS: '120000',
      DEMO_USERS: 'carol:pw:carol-token',
      ADMIN_TOKEN: 's3cret',
      TRUST_PROXY: '2',
      FAILURE_POLICY: 'closed',
      VALIDATE_RESPONSES: 'false',
      KEY_PREFIX: 'app',
      OVERRIDES_KEY: 'app:ov',
      OVERRIDES_REFRESH_MS: '1000',
    });
    expect(config).toMatchObject({
      port: 8080,
      redisUrl: 'redis://cache:6380/2',
      algorithm: 'sliding-log',
      limits: {
        unauthenticated: { limit: 10, windowMs: 60_000 },
        authenticated: { limit: 20, windowMs: 120_000 },
      },
      users: [{ id: 'carol', password: 'pw', token: 'carol-token' }],
      adminToken: 's3cret',
      trustProxy: 2,
      failurePolicy: 'closed',
      validateResponses: false,
      keyPrefix: 'app',
      overridesKey: 'app:ov',
      overridesRefreshMs: 1_000,
    });
  });

  it('maps TRUST_PROXY onto the Express setting', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toBe(
      'loopback, 10.0.0.0/8',
    );
  });

  it('turns response validation off in production unless asked for', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).validateResponses).toBe(false);
    expect(
      loadConfig({ NODE_ENV: 'production', VALIDATE_RESPONSES: 'true' }).validateResponses,
    ).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test' }).validateResponses).toBe(true);
  });

  it('rejects invalid values with a message naming the variable', () => {
    expect(() => loadConfig({ RATE_LIMIT_ALGORITHM: 'leaky' })).toThrow(/RATE_LIMIT_ALGORITHM/);
    expect(() => loadConfig({ UNAUTH_LIMIT: 'lots' })).toThrow(/UNAUTH_LIMIT/);
    expect(() => loadConfig({ AUTH_WINDOW_MS: '0' })).toThrow(/AUTH_WINDOW_MS/);
    expect(() => loadConfig({ FAILURE_POLICY: 'maybe' })).toThrow(/FAILURE_POLICY/);
    expect(() => loadConfig({ DEMO_USERS: 'alice:only-two' })).toThrow(/DEMO_USERS/);
    expect(() => loadConfig({ PORT: '99999' })).toThrow(/PORT/);
  });
});
