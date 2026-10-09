import { describe, expect, it } from 'vitest';
import { createPathMatcher } from '../../src/core/path-matcher.js';
import { compileRules, resolveLimit, type CompiledRule } from '../../src/core/policy.js';
import type { TierLimits } from '../../src/core/types.js';

describe('createPathMatcher', () => {
  it('matches exact paths and tolerates a trailing slash', () => {
    const m = createPathMatcher('/api/search');
    expect(m('/api/search')).toBe(true);
    expect(m('/api/search/')).toBe(true);
    expect(m('/api/searching')).toBe(false);
    expect(m('/api')).toBe(false);
  });

  it('supports Express-style params and named wildcards', () => {
    expect(createPathMatcher('/users/:id')('/users/42')).toBe(true);
    expect(createPathMatcher('/users/:id')('/users/42/posts')).toBe(false);
    expect(createPathMatcher('/files/*rest')('/files/a/b/c.txt')).toBe(true);
  });

  it('accepts a RegExp', () => {
    const m = createPathMatcher(/^\/api\/v\d+\/items$/);
    expect(m('/api/v2/items')).toBe(true);
    expect(m('/api/vx/items')).toBe(false);
  });

  it('is stateless even when given a global RegExp', () => {
    const m = createPathMatcher(/^\/a$/g);
    expect(m('/a')).toBe(true);
    expect(m('/a')).toBe(true);
  });

  it('fails loudly on an invalid pattern', () => {
    expect(() => createPathMatcher('/api/*')).toThrow(/Invalid path pattern "\/api\/\*"/);
  });

  it('treats malformed percent-encoding as a non-match instead of throwing', () => {
    expect(createPathMatcher('/users/:id')('/users/%E0%A4%A')).toBe(false);
  });
});

describe('compileRules', () => {
  const limit = { limit: 5, windowMs: 1_000 };

  it('derives the id from the path when none is given', () => {
    const [rule] = compileRules([{ path: '/api/search' }]);
    expect(rule?.id).toBe('/api/search');
  });

  it('matches methods case-insensitively and all methods when omitted', () => {
    const [get, any] = compileRules([
      { id: 'get-only', path: '/a', methods: ['get'] },
      { id: 'any', path: '/b' },
    ]) as [CompiledRule, CompiledRule];
    expect(get.matches('/a', 'GET')).toBe(true);
    expect(get.matches('/a', 'POST')).toBe(false);
    expect(any.matches('/b', 'DELETE')).toBe(true);
  });

  it('rejects duplicate ids and the reserved "default" id', () => {
    expect(() =>
      compileRules([
        { id: 'x', path: '/a' },
        { id: 'x', path: '/b' },
      ]),
    ).toThrow(/duplicate rule id "x"/);
    expect(() => compileRules([{ id: 'default', path: '/a' }])).toThrow(/reserved/);
  });

  it('validates limits and algorithms at configuration time', () => {
    expect(() =>
      compileRules([{ path: '/a', limits: { authenticated: { limit: -1, windowMs: 1 } } }]),
    ).toThrow(/limit/);
    expect(() =>
      compileRules([{ path: '/a', limits: { authenticated: { limit: 1, windowMs: 0 } } }]),
    ).toThrow(/windowMs/);
    expect(() => compileRules([{ path: '/a', algorithm: 'leaky-bucket' as never }])).toThrow(
      /unknown algorithm/,
    );
    expect(() => compileRules([{ path: '/a', limits: { authenticated: limit } }])).not.toThrow();
  });
});

describe('resolveLimit', () => {
  const defaults: TierLimits = {
    unauthenticated: { limit: 100, windowMs: 3_600_000 },
    authenticated: { limit: 200, windowMs: 3_600_000 },
    premium: { limit: 1_000, windowMs: 3_600_000 },
  };
  const [rule] = compileRules([
    { id: 'search', path: '/search', limits: { unauthenticated: { limit: 20, windowMs: 60_000 } } },
  ]) as [CompiledRule];

  it('prefers the rule limit for the tier', () => {
    expect(resolveLimit('unauthenticated', rule, defaults)).toEqual({
      limit: 20,
      windowMs: 60_000,
    });
  });

  it('falls back to the default for tiers the rule omits', () => {
    expect(resolveLimit('authenticated', rule, defaults)).toEqual(defaults.authenticated);
  });

  it('uses the default rule when no endpoint rule matched', () => {
    expect(resolveLimit('premium', undefined, defaults)).toEqual(defaults.premium);
  });

  it('lets unknown custom tiers inherit the authenticated limit', () => {
    expect(resolveLimit('gold', undefined, defaults)).toEqual(defaults.authenticated);
  });
});
