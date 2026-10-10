import type { FailurePolicy } from '@challenge/rate-limiter';
import type { Role } from '../core/types.js';
import type { ChatConfig, SeedUser } from './app.js';

export interface ServerConfig extends ChatConfig {
  port: number;
  redisUrl: string;
  databaseFile: string;
}

type Env = Record<string, string | undefined>;

const DEFAULT_JWT_SECRET = 'dev-only-change-me';
const DEFAULT_SEED_USERS: SeedUser[] = [
  { username: 'admin', password: 'admin-password', role: 'admin' },
  { username: 'alice', password: 'wonderland', role: 'user' },
  { username: 'bob', password: 'bob-builder', role: 'user' },
];
const ROLES: readonly Role[] = ['user', 'admin'];
const FAILURE_POLICIES: readonly FailurePolicy[] = ['open', 'closed'];

class ConfigError extends Error {
  constructor(name: string, problem: string) {
    super(`Invalid environment variable ${name}: ${problem}`);
    this.name = 'ConfigError';
  }
}

function integer(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(name, `expected an integer, got "${raw}"`);
  if (value < min || value > max)
    throw new ConfigError(name, `must be between ${min} and ${max}, got ${value}`);
  return value;
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw as T))
    throw new ConfigError(name, `expected one of ${allowed.join(', ')}, got "${raw}"`);
  return raw as T;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(name, `expected true or false, got "${raw}"`);
}

function trustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** `username:password:role, ...` */
function seedUsers(raw: string | undefined): SeedUser[] {
  if (raw === undefined || raw === '') return DEFAULT_SEED_USERS;
  return raw.split(',').map((entry) => {
    const parts = entry.trim().split(':');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      throw new ConfigError(
        'SEED_USERS',
        `expected "username:password:role" entries, got "${entry.trim()}"`,
      );
    }
    const [username, password, role] = parts as [string, string, string];
    if (!ROLES.includes(role as Role))
      throw new ConfigError('SEED_USERS', `role must be user or admin, got "${role}"`);
    return { username, password, role: role as Role };
  });
}

function assertProductionSecrets(env: Env): void {
  const secret = env.JWT_SECRET;
  if (!secret || secret === DEFAULT_JWT_SECRET || secret.length < 32) {
    throw new ConfigError(
      'JWT_SECRET',
      'must be set to a non-default value of at least 32 characters when NODE_ENV=production',
    );
  }
  if (!env.SEED_USERS)
    throw new ConfigError('SEED_USERS', 'must be set explicitly when NODE_ENV=production');
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  if (production) assertProductionSecrets(env);
  return {
    port: integer(env, 'PORT', 3001, 1, 65_535),
    redisUrl: env.REDIS_URL || 'redis://localhost:6379',
    databaseFile: env.DATABASE_FILE || './data/chat.db',
    jwtSecret: env.JWT_SECRET || DEFAULT_JWT_SECRET,
    jwtTtlSeconds: integer(env, 'JWT_TTL_SECONDS', 43_200, 1),
    seedUsers: seedUsers(env.SEED_USERS),
    defaultRoom: env.DEFAULT_ROOM || 'general',
    messageLimit: {
      limit: integer(env, 'MESSAGE_LIMIT', 10, 0),
      windowMs: integer(env, 'MESSAGE_WINDOW_MS', 10_000, 1),
    },
    loginLimit: {
      limit: integer(env, 'LOGIN_LIMIT', 5, 0),
      windowMs: integer(env, 'LOGIN_WINDOW_MS', 900_000, 1),
    },
    trustProxy: trustProxy(env.TRUST_PROXY),
    ...(env.CLIENT_IP_HEADER ? { clientIpHeader: env.CLIENT_IP_HEADER } : {}),
    failurePolicy: oneOf<FailurePolicy>(env, 'FAILURE_POLICY', FAILURE_POLICIES, 'open'),
    validateResponses: boolean(env, 'VALIDATE_RESPONSES', !production),
    keyPrefix: env.KEY_PREFIX || 'chat',
    snapshotSize: integer(env, 'SNAPSHOT_SIZE', 50, 1, 500),
  };
}
