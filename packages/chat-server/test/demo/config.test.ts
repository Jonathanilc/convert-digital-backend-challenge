import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/demo/config.js';

const production = {
  NODE_ENV: 'production',
  JWT_SECRET: 'a-very-long-and-random-secret-value-for-production-use',
  SEED_USERS: 'root:root-password:admin',
};

describe('loadConfig (chat server)', () => {
  it('provides development defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 3001,
      redisUrl: 'redis://localhost:6379',
      databaseFile: './data/chat.db',
      jwtSecret: 'dev-only-change-me',
      jwtTtlSeconds: 43_200,
      defaultRoom: 'general',
      messageLimit: { limit: 10, windowMs: 10_000 },
      loginLimit: { limit: 5, windowMs: 900_000 },
      trustProxy: false,
      validateResponses: true,
      keyPrefix: 'chat',
      snapshotSize: 50,
      failurePolicy: 'open',
    });
    expect(config.seedUsers.map((u) => `${u.username}:${u.role}`)).toEqual([
      'admin:admin',
      'alice:user',
      'bob:user',
    ]);
    expect(config.clientIpHeader).toBeUndefined();
  });

  it('reads every setting from the environment', () => {
    const config = loadConfig({
      PORT: '8080',
      REDIS_URL: 'redis://cache:6380/1',
      DATABASE_FILE: '/data/chat.db',
      JWT_SECRET: 'another-secret',
      JWT_TTL_SECONDS: '600',
      SEED_USERS: 'carol:carol-password:admin, dave:dave-password:user',
      DEFAULT_ROOM: 'lobby',
      MESSAGE_LIMIT: '3',
      MESSAGE_WINDOW_MS: '5000',
      LOGIN_LIMIT: '2',
      LOGIN_WINDOW_MS: '60000',
      TRUST_PROXY: 'true',
      CLIENT_IP_HEADER: 'Fly-Client-IP',
      FAILURE_POLICY: 'closed',
      VALIDATE_RESPONSES: 'false',
      KEY_PREFIX: 'c',
      SNAPSHOT_SIZE: '20',
    });
    expect(config).toMatchObject({
      port: 8080,
      redisUrl: 'redis://cache:6380/1',
      databaseFile: '/data/chat.db',
      jwtSecret: 'another-secret',
      jwtTtlSeconds: 600,
      seedUsers: [
        { username: 'carol', password: 'carol-password', role: 'admin' },
        { username: 'dave', password: 'dave-password', role: 'user' },
      ],
      defaultRoom: 'lobby',
      messageLimit: { limit: 3, windowMs: 5_000 },
      loginLimit: { limit: 2, windowMs: 60_000 },
      trustProxy: true,
      clientIpHeader: 'Fly-Client-IP',
      failurePolicy: 'closed',
      validateResponses: false,
      keyPrefix: 'c',
      snapshotSize: 20,
    });
  });

  it('rejects invalid values naming the variable', () => {
    expect(() => loadConfig({ SEED_USERS: 'carol:pw' })).toThrow(/SEED_USERS/);
    expect(() => loadConfig({ SEED_USERS: 'carol:carol-password:superuser' })).toThrow(
      /SEED_USERS/,
    );
    expect(() => loadConfig({ MESSAGE_LIMIT: 'many' })).toThrow(/MESSAGE_LIMIT/);
    expect(() => loadConfig({ JWT_TTL_SECONDS: '0' })).toThrow(/JWT_TTL_SECONDS/);
    expect(() => loadConfig({ FAILURE_POLICY: 'maybe' })).toThrow(/FAILURE_POLICY/);
  });

  it('refuses demo secrets in production', () => {
    expect(() => loadConfig(production)).not.toThrow();
    expect(() => loadConfig({ ...production, JWT_SECRET: undefined })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...production, JWT_SECRET: 'dev-only-change-me' })).toThrow(
      /JWT_SECRET/,
    );
    expect(() => loadConfig({ ...production, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...production, SEED_USERS: undefined })).toThrow(/SEED_USERS/);
    expect(loadConfig(production).validateResponses).toBe(false);
  });
});
