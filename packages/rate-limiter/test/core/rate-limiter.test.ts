import { describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import type {
  Identity,
  Override,
  OverrideContext,
  OverrideProvider,
  RateLimiterOptions,
  RateLimitStore,
  TierLimits,
} from '../../src/core/types.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { fakeClock } from '../helpers/clock.js';

const limits: TierLimits = {
  unauthenticated: { limit: 2, windowMs: 1_000 },
  authenticated: { limit: 4, windowMs: 1_000 },
};
const anon: Identity = { key: 'ip:203.0.113.9', tier: 'unauthenticated', ip: '203.0.113.9' };
const alice: Identity = {
  key: 'user:alice',
  tier: 'authenticated',
  userId: 'alice',
  ip: '203.0.113.9',
};

const request = (identity: Identity, path = '/api/public', method = 'GET') => ({
  identity,
  path,
  method,
});

function setup(options: Partial<RateLimiterOptions> = {}) {
  const clock = fakeClock();
  const store = new MemoryStore({ now: clock.now, sweepIntervalMs: 0 });
  const limiter = new RateLimiter({ store, limits, now: clock.now, ...options });
  return { clock, store, limiter };
}

const provider = (
  override?: Override,
  resolve = vi.fn(),
): OverrideProvider & { resolve: typeof resolve } => {
  resolve.mockResolvedValue(override);
  return { resolve };
};

const override = (effect: Override['effect'], extra: Partial<Override> = {}): Override => ({
  id: 'ov-1',
  reason: 'test',
  criteria: {},
  effect,
  expiresAt: Number.MAX_SAFE_INTEGER,
  createdAt: 0,
  ...extra,
});

async function drain(limiter: RateLimiter, identity: Identity, n: number, path?: string) {
  const decisions = [];
  for (let i = 0; i < n; i++) decisions.push(await limiter.check(request(identity, path)));
  return decisions;
}

describe('RateLimiter', () => {
  describe('tiers', () => {
    it('applies the unauthenticated limit to anonymous requests', async () => {
      const { limiter } = setup();
      const [a, b, c] = await drain(limiter, anon, 3);
      expect([a?.allowed, b?.allowed, c?.allowed]).toEqual([true, true, false]);
      expect(c).toMatchObject({
        limit: 2,
        remaining: 0,
        retryAfterMs: 1_000,
        tier: 'unauthenticated',
      });
    });

    it('applies the authenticated limit to identified users', async () => {
      const { limiter } = setup();
      const decisions = await drain(limiter, alice, 5);
      expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, true, false]);
      expect(decisions[4]).toMatchObject({ limit: 4, tier: 'authenticated' });
    });

    it('produces a complete, self-describing decision', async () => {
      const { limiter } = setup();
      expect(await limiter.check(request(anon))).toEqual({
        allowed: true,
        limit: 2,
        remaining: 1,
        resetMs: 1_000,
        retryAfterMs: null,
        windowMs: 1_000,
        algorithm: 'fixed-window',
        ruleId: 'default',
        tier: 'unauthenticated',
        key: 'rl:fw:default:ip:203.0.113.9',
        override: undefined,
      });
    });
  });

  describe('endpoint rules', () => {
    const endpoints = [
      {
        id: 'search',
        path: '/api/search',
        algorithm: 'sliding-log' as const,
        limits: { unauthenticated: { limit: 1, windowMs: 500 } },
      },
      {
        id: 'login',
        path: '/api/login',
        methods: ['POST'],
        limits: { unauthenticated: { limit: 1, windowMs: 1_000 } },
      },
    ];

    it('uses the first matching rule, including its algorithm and window', async () => {
      const { limiter } = setup({ endpoints });
      const [first, second] = await drain(limiter, anon, 2, '/api/search');
      expect(first).toMatchObject({
        allowed: true,
        ruleId: 'search',
        algorithm: 'sliding-log',
        windowMs: 500,
        key: 'rl:sl:search:ip:203.0.113.9',
      });
      expect(second?.allowed).toBe(false);
    });

    it('counts each endpoint rule separately', async () => {
      const { limiter } = setup({ endpoints });
      await drain(limiter, anon, 1, '/api/search'); // exhausts the search budget
      expect((await limiter.check(request(anon, '/api/search'))).allowed).toBe(false);
      expect((await limiter.check(request(anon, '/api/public'))).allowed).toBe(true);
    });

    it('falls back to the default rule when the method does not match', async () => {
      const { limiter } = setup({ endpoints });
      expect(await limiter.check(request(anon, '/api/login', 'GET'))).toMatchObject({
        ruleId: 'default',
      });
      expect(await limiter.check(request(anon, '/api/login', 'POST'))).toMatchObject({
        ruleId: 'login',
      });
    });

    it('lets a rule omit tiers, which then inherit the defaults', async () => {
      const { limiter } = setup({ endpoints });
      expect(await limiter.check(request(alice, '/api/search'))).toMatchObject({
        ruleId: 'search',
        limit: 4,
      });
    });
  });

  describe('overrides', () => {
    it('gives the provider the full context of the request', async () => {
      const overrides = provider(undefined);
      const { limiter, clock } = setup({ overrides });
      await limiter.check(request(alice, '/api/public', 'GET'));
      expect(overrides.resolve).toHaveBeenCalledWith({
        identity: alice,
        ruleId: 'default',
        path: '/api/public',
        method: 'GET',
        now: clock.now(),
      } satisfies OverrideContext);
    });

    it('scales the limit with a multiplier, rounding down, and reports the override', async () => {
      const { limiter } = setup({ overrides: provider(override({ multiplier: 1.5 })) });
      const decisions = await drain(limiter, anon, 4);
      expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
      expect(decisions[0]).toMatchObject({ limit: 3, override: { id: 'ov-1', reason: 'test' } });
    });

    it('applies an absolute limit before the multiplier', async () => {
      const { limiter } = setup({ overrides: provider(override({ limit: 10, multiplier: 0.5 })) });
      expect(await limiter.check(request(anon))).toMatchObject({ limit: 5 });
    });

    it('bypasses the store entirely when the effect is bypass', async () => {
      const store = new MemoryStore({ sweepIntervalMs: 0 });
      const consume = vi.spyOn(store, 'consume');
      const limiter = new RateLimiter({
        store,
        limits,
        overrides: provider(override({ bypass: true })),
      });
      expect(await limiter.check(request(anon))).toMatchObject({
        allowed: true,
        remaining: 2,
        retryAfterMs: null,
      });
      expect(consume).not.toHaveBeenCalled();
    });

    it('blocks immediately when the limit is overridden to 0', async () => {
      const { limiter } = setup({ overrides: provider(override({ limit: 0 })) });
      expect(await limiter.check(request(anon))).toMatchObject({
        allowed: false,
        limit: 0,
        remaining: 0,
      });
    });

    it('can switch algorithm and window, using a separate key for the new data type', async () => {
      const { limiter } = setup({
        overrides: provider(override({ algorithm: 'sliding-log', windowMs: 250 })),
      });
      expect(await limiter.check(request(anon))).toMatchObject({
        algorithm: 'sliding-log',
        windowMs: 250,
        key: 'rl:sl:default:ip:203.0.113.9',
      });
    });

    it('falls back to base limits and reports when the provider fails', async () => {
      const onStoreError = vi.fn();
      const overrides: OverrideProvider = {
        resolve: vi.fn().mockRejectedValue(new Error('redis down')),
      };
      const { limiter } = setup({ overrides, onStoreError });
      const decision = await limiter.check(request(anon));
      expect(decision).toMatchObject({ allowed: true, limit: 2, override: undefined });
      expect(decision.degraded).toBeUndefined();
      expect(onStoreError).toHaveBeenCalledWith(expect.any(Error), request(anon));
    });
  });

  describe('failure policy', () => {
    const broken: RateLimitStore = {
      consume: async () => {
        throw new Error('ECONNREFUSED');
      },
      reset: async () => undefined,
    };

    it('fails open by default and flags the decision as degraded', async () => {
      const onStoreError = vi.fn();
      const limiter = new RateLimiter({ store: broken, limits, onStoreError });
      expect(await limiter.check(request(anon))).toMatchObject({
        allowed: true,
        degraded: true,
        remaining: 2,
      });
      expect(onStoreError).toHaveBeenCalledOnce();
    });

    it('fails closed when configured, with a short retry hint', async () => {
      const limiter = new RateLimiter({ store: broken, limits, failurePolicy: 'closed' });
      expect(await limiter.check(request(anon))).toMatchObject({
        allowed: false,
        degraded: true,
        remaining: 0,
        retryAfterMs: 1_000,
      });
    });
  });

  it('can reset the counter behind a decision', async () => {
    const { limiter } = setup();
    const [, , denied] = await drain(limiter, anon, 3);
    expect(denied?.allowed).toBe(false);
    await limiter.reset(denied!.key);
    expect((await limiter.check(request(anon))).allowed).toBe(true);
  });

  it('isolates subjects from each other', async () => {
    const { limiter } = setup();
    await drain(limiter, anon, 2);
    expect((await limiter.check(request(anon))).allowed).toBe(false);
    expect((await limiter.check(request({ ...anon, key: 'ip:198.51.100.1' }))).allowed).toBe(true);
  });

  it('validates its configuration eagerly', () => {
    const store = new MemoryStore({ sweepIntervalMs: 0 });
    expect(
      () =>
        new RateLimiter({
          store,
          limits: { unauthenticated: limits.unauthenticated } as TierLimits,
        }),
    ).toThrow(/authenticated/);
    expect(() => new RateLimiter({ store, limits, algorithm: 'token-bucket' as never })).toThrow(
      /unknown algorithm/,
    );
    expect(() =>
      new RateLimiter({ store, limits, keyPrefix: 'app' }).buildKey(
        'fixed-window',
        'default',
        'ip:x',
      ),
    ).not.toThrow();
  });
});
