import {
  ALGORITHMS,
  type Algorithm,
  type EndpointRule,
  type FailurePolicy,
} from '../core/types.js';
import type { AppConfig } from './app.js';
import type { DemoUser } from './auth.js';

export interface ServerConfig extends AppConfig {
  port: number;
  redisUrl: string;
}

/** Endpoint-specific limits of the demo API. Kept in code because they are part of the contract. */
export const DEMO_ENDPOINTS: EndpointRule[] = [
  {
    id: 'login',
    path: '/api/login',
    methods: ['POST'],
    limits: {
      unauthenticated: { limit: 5, windowMs: 15 * 60_000 },
      authenticated: { limit: 5, windowMs: 15 * 60_000 },
    },
  },
  {
    id: 'search',
    path: '/api/search',
    algorithm: 'sliding-log',
    limits: {
      unauthenticated: { limit: 20, windowMs: 60_000 },
      authenticated: { limit: 60, windowMs: 60_000 },
    },
  },
];

const DEFAULT_USERS: DemoUser[] = [
  { id: 'alice', password: 'wonderland', token: 'alice-token' },
  { id: 'bob', password: 'builder', token: 'bob-token' },
];

const FAILURE_POLICIES: readonly FailurePolicy[] = ['open', 'closed'];

type Env = Record<string, string | undefined>;

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
  range: { min: number; max?: number },
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(name, `expected an integer, got "${raw}"`);
  if (value < range.min || (range.max !== undefined && value > range.max)) {
    throw new ConfigError(
      name,
      `must be between ${range.min} and ${range.max ?? '∞'}, got ${value}`,
    );
  }
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

/** Express accepts `true`/`false`, a hop count, or a list of trusted addresses/subnets. */
function trustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** `id:password:token,id:password:token` */
function users(raw: string | undefined): DemoUser[] {
  if (raw === undefined || raw === '') return DEFAULT_USERS;
  return raw.split(',').map((entry) => {
    const parts = entry.trim().split(':');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      throw new ConfigError('DEMO_USERS', `expected "id:password:token" entries, got "${entry}"`);
    }
    const [id, password, token] = parts as [string, string, string];
    return { id, password, token };
  });
}

const DEFAULT_ADMIN_TOKEN = 'admin-secret';

/** In production, demo defaults are a liability: refuse to start with them. */
function assertProductionSecrets(env: Env): void {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN === DEFAULT_ADMIN_TOKEN) {
    throw new ConfigError(
      'ADMIN_TOKEN',
      'must be set to a non-default value when NODE_ENV=production',
    );
  }
  if (!env.DEMO_USERS) {
    throw new ConfigError('DEMO_USERS', 'must be set explicitly when NODE_ENV=production');
  }
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  if (production) assertProductionSecrets(env);
  return {
    port: integer(env, 'PORT', 3000, { min: 1, max: 65_535 }),
    redisUrl: env.REDIS_URL || 'redis://localhost:6379',
    algorithm: oneOf<Algorithm>(env, 'RATE_LIMIT_ALGORITHM', ALGORITHMS, 'fixed-window'),
    limits: {
      unauthenticated: {
        limit: integer(env, 'UNAUTH_LIMIT', 100, { min: 0 }),
        windowMs: integer(env, 'UNAUTH_WINDOW_MS', 3_600_000, { min: 1 }),
      },
      authenticated: {
        limit: integer(env, 'AUTH_LIMIT', 200, { min: 0 }),
        windowMs: integer(env, 'AUTH_WINDOW_MS', 3_600_000, { min: 1 }),
      },
    },
    endpoints: DEMO_ENDPOINTS,
    users: users(env.DEMO_USERS),
    adminToken: env.ADMIN_TOKEN || DEFAULT_ADMIN_TOKEN,
    trustProxy: trustProxy(env.TRUST_PROXY),
    ...(env.CLIENT_IP_HEADER ? { clientIpHeader: env.CLIENT_IP_HEADER } : {}),
    failurePolicy: oneOf<FailurePolicy>(env, 'FAILURE_POLICY', FAILURE_POLICIES, 'open'),
    validateResponses: boolean(env, 'VALIDATE_RESPONSES', !production),
    keyPrefix: env.KEY_PREFIX || 'rl',
    overridesKey: env.OVERRIDES_KEY || 'rl:overrides',
    overridesRefreshMs: integer(env, 'OVERRIDES_REFRESH_MS', 5_000, { min: 0 }),
  };
}
