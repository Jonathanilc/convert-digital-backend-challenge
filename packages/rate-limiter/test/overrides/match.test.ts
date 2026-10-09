import { describe, expect, it } from 'vitest';
import {
  overrideMatches,
  pickOverride,
  specificity,
  validateOverride,
} from '../../src/overrides/match.js';
import { alice, anon, ctx, makeOverride, T0 } from './fixtures.js';

describe('overrideMatches', () => {
  it('matches every request when criteria are empty', () => {
    expect(overrideMatches(makeOverride(), ctx())).toBe(true);
    expect(overrideMatches(makeOverride(), ctx({ identity: anon, ruleId: 'search' }))).toBe(true);
  });

  it('ignores expired overrides and ones that have not started yet', () => {
    expect(overrideMatches(makeOverride({ expiresAt: T0 }), ctx({ now: T0 }))).toBe(false);
    expect(overrideMatches(makeOverride({ startsAt: T0 + 1 }), ctx({ now: T0 }))).toBe(false);
    expect(overrideMatches(makeOverride({ startsAt: T0 }), ctx({ now: T0 }))).toBe(true);
  });

  it('requires every present criterion to match', () => {
    const o = makeOverride({ criteria: { userIds: ['alice'], ruleIds: ['search'] } });
    expect(overrideMatches(o, ctx({ ruleId: 'default' }))).toBe(false);
    expect(overrideMatches(o, ctx({ ruleId: 'search' }))).toBe(true);
    expect(overrideMatches(o, ctx({ ruleId: 'search', identity: anon }))).toBe(false);
  });

  it('never matches userIds against anonymous identities', () => {
    expect(
      overrideMatches(makeOverride({ criteria: { userIds: ['alice'] } }), ctx({ identity: anon })),
    ).toBe(false);
  });

  it('matches ips and tiers', () => {
    expect(
      overrideMatches(
        makeOverride({ criteria: { ips: ['198.51.100.7'] } }),
        ctx({ identity: anon }),
      ),
    ).toBe(true);
    expect(
      overrideMatches(
        makeOverride({ criteria: { ips: ['198.51.100.7'] } }),
        ctx({ identity: alice }),
      ),
    ).toBe(false);
    expect(
      overrideMatches(
        makeOverride({ criteria: { tiers: ['unauthenticated'] } }),
        ctx({ identity: anon }),
      ),
    ).toBe(true);
    expect(overrideMatches(makeOverride({ criteria: { tiers: ['unauthenticated'] } }), ctx())).toBe(
      false,
    );
  });

  it('matches paths with Express-style patterns', () => {
    const o = makeOverride({ criteria: { paths: ['/api/users/:id'] } });
    expect(overrideMatches(o, ctx({ path: '/api/users/42' }))).toBe(true);
    expect(overrideMatches(o, ctx({ path: '/api/users' }))).toBe(false);
  });
});

describe('pickOverride', () => {
  const global = makeOverride({ id: 'global', effect: { multiplier: 2 } });
  const perUser = makeOverride({
    id: 'alice',
    criteria: { userIds: ['alice'] },
    effect: { limit: 1_000 },
  });
  const perUserAndRule = makeOverride({
    id: 'alice-search',
    criteria: { userIds: ['alice'], ruleIds: ['search'] },
    effect: { bypass: true },
  });

  it('counts criteria dimensions as specificity', () => {
    expect(specificity(global)).toBe(0);
    expect(specificity(perUser)).toBe(1);
    expect(specificity(perUserAndRule)).toBe(2);
  });

  it('prefers the most specific match', () => {
    expect(pickOverride([global, perUser, perUserAndRule], ctx())?.id).toBe('alice');
    expect(pickOverride([global, perUser, perUserAndRule], ctx({ ruleId: 'search' }))?.id).toBe(
      'alice-search',
    );
    expect(pickOverride([global, perUser, perUserAndRule], ctx({ identity: anon }))?.id).toBe(
      'global',
    );
  });

  it('breaks ties in favour of the newest override', () => {
    const older = makeOverride({ id: 'older', createdAt: T0 - 5_000 });
    const newer = makeOverride({ id: 'newer', createdAt: T0 - 1_000 });
    expect(pickOverride([older, newer], ctx())?.id).toBe('newer');
    expect(pickOverride([newer, older], ctx())?.id).toBe('newer');
  });

  it('returns undefined when nothing matches', () => {
    expect(pickOverride([perUser], ctx({ identity: anon }))).toBeUndefined();
    expect(pickOverride([], ctx())).toBeUndefined();
  });
});

describe('validateOverride', () => {
  it('accepts a well-formed override', () => {
    expect(() => validateOverride(makeOverride())).not.toThrow();
  });

  it.each<[string, Partial<import('../../src/core/types.js').Override>, RegExp]>([
    ['missing id', { id: '' }, /"id"/],
    ['blank reason', { reason: '  ' }, /"reason"/],
    ['non-numeric expiresAt', { expiresAt: Number.NaN }, /"expiresAt"/],
    ['effect without fields', { effect: {} }, /at least one effect/],
    ['negative limit', { effect: { limit: -1 } }, /"limit"/],
    ['fractional limit', { effect: { limit: 1.5 } }, /"limit"/],
    ['negative multiplier', { effect: { multiplier: -2 } }, /"multiplier"/],
    ['zero window', { effect: { windowMs: 0 } }, /"windowMs"/],
    ['unknown algorithm', { effect: { algorithm: 'gcra' as never } }, /algorithm/],
    ['non-string criteria values', { criteria: { userIds: [1 as never] } }, /criteria\.userIds/],
    ['invalid path pattern', { criteria: { paths: ['/api/*'] } }, /Invalid path pattern/],
  ])('rejects %s', (_label, partial, message) => {
    expect(() => validateOverride(makeOverride(partial))).toThrow(message);
  });
});
