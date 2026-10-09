import type { Identity, Override, OverrideContext } from '../../src/core/types.js';

export const T0 = 1_700_000_000_000;

export const alice: Identity = {
  key: 'user:alice',
  tier: 'authenticated',
  userId: 'alice',
  ip: '203.0.113.9',
};
export const anon: Identity = {
  key: 'ip:198.51.100.7',
  tier: 'unauthenticated',
  ip: '198.51.100.7',
};

export function ctx(partial: Partial<OverrideContext> = {}): OverrideContext {
  return {
    identity: alice,
    ruleId: 'default',
    path: '/api/public',
    method: 'GET',
    now: T0,
    ...partial,
  };
}

export function makeOverride(partial: Partial<Override> = {}): Override {
  return {
    id: 'ov-1',
    reason: 'test',
    criteria: {},
    effect: { multiplier: 2 },
    expiresAt: T0 + 60_000,
    createdAt: T0 - 1_000,
    ...partial,
  };
}
