import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import type { Decision } from '../../src/core/types.js';
import { applyRateLimitHeaders, retryAfterSeconds } from '../../src/express/headers.js';

function fakeResponse() {
  const headers = new Map<string, string>();
  const res = {
    setHeader: (name: string, value: string) => headers.set(name, value),
  } as unknown as Response;
  return { res, headers: () => Object.fromEntries(headers) };
}

const allowed: Decision = {
  allowed: true,
  limit: 100,
  remaining: 42,
  resetMs: 1_501,
  retryAfterMs: null,
  windowMs: 3_600_000,
  algorithm: 'fixed-window',
  ruleId: 'default',
  tier: 'unauthenticated',
  key: 'rl:fw:default:ip:1.1.1.1',
};
const denied: Decision = {
  ...allowed,
  allowed: false,
  remaining: 0,
  resetMs: 2_400,
  retryAfterMs: 2_400,
};

describe('applyRateLimitHeaders', () => {
  it('emits the IETF RateLimit fields with seconds rounded up', () => {
    const { res, headers } = fakeResponse();
    applyRateLimitHeaders(res, allowed, 'standard');
    expect(headers()).toEqual({
      'RateLimit-Limit': '100',
      'RateLimit-Remaining': '42',
      'RateLimit-Reset': '2',
      'RateLimit-Policy': '100;w=3600',
    });
  });

  it('adds Retry-After only when the request was denied', () => {
    const { res, headers } = fakeResponse();
    applyRateLimitHeaders(res, denied, 'standard');
    expect(headers()).toMatchObject({ 'RateLimit-Remaining': '0', 'Retry-After': '3' });
  });

  it('supports the legacy X-RateLimit trio and both styles together', () => {
    const legacy = fakeResponse();
    applyRateLimitHeaders(legacy.res, allowed, 'legacy');
    expect(Object.keys(legacy.headers())).toEqual([
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ]);
    expect(Number(legacy.headers()['X-RateLimit-Reset'])).toBeGreaterThan(Date.now() / 1000);

    const both = fakeResponse();
    applyRateLimitHeaders(both.res, allowed, 'both');
    expect(Object.keys(both.headers())).toHaveLength(7);
  });

  it('emits nothing for style none or for degraded decisions', () => {
    const none = fakeResponse();
    applyRateLimitHeaders(none.res, denied, 'none');
    expect(none.headers()).toEqual({});

    const degraded = fakeResponse();
    applyRateLimitHeaders(degraded.res, { ...allowed, degraded: true }, 'standard');
    expect(degraded.headers()).toEqual({});
  });

  it('never advertises a Retry-After below one second', () => {
    expect(retryAfterSeconds({ ...denied, retryAfterMs: 20 })).toBe(1);
    expect(retryAfterSeconds({ ...denied, retryAfterMs: 1_001 })).toBe(2);
  });
});
