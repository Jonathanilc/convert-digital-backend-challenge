import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { identifyByIp, identifyByUserOrIp, normalizeIp } from '../../src/express/identify.js';

const req = (partial: Record<string, unknown>) => partial as unknown as Request;

describe('normalizeIp', () => {
  it('strips the IPv4-mapped IPv6 prefix and tolerates missing values', () => {
    expect(normalizeIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp(undefined)).toBe('unknown');
  });
});

describe('identifyByUserOrIp', () => {
  const identify = identifyByUserOrIp();

  it('keys authenticated requests by user id', () => {
    expect(identify(req({ ip: '::ffff:203.0.113.9', user: { id: 'alice' } }))).toEqual({
      key: 'user:alice',
      tier: 'authenticated',
      userId: 'alice',
      ip: '203.0.113.9',
    });
  });

  it('accepts numeric user ids', () => {
    expect(identify(req({ ip: '203.0.113.9', user: { id: 42 } }))).toMatchObject({
      key: 'user:42',
      userId: '42',
    });
  });

  it('keys anonymous requests by ip', () => {
    expect(identify(req({ ip: '203.0.113.9' }))).toEqual({
      key: 'ip:203.0.113.9',
      tier: 'unauthenticated',
      ip: '203.0.113.9',
    });
    expect(identify(req({ ip: '203.0.113.9', user: {} }))).toMatchObject({
      tier: 'unauthenticated',
    });
  });

  it('supports a custom user id extractor', () => {
    const custom = identifyByUserOrIp({ getUserId: (r) => r.get('x-api-key') });
    expect(custom(req({ ip: '1.1.1.1', get: () => 'key-1' }))).toMatchObject({
      key: 'user:key-1',
      tier: 'authenticated',
    });
  });
});

describe('identifyByIp', () => {
  it('always keys by ip and lets authentication only change the tier', () => {
    const identify = identifyByIp();
    expect(identify(req({ ip: '203.0.113.9', user: { id: 'alice' } }))).toEqual({
      key: 'ip:203.0.113.9',
      tier: 'authenticated',
      userId: 'alice',
      ip: '203.0.113.9',
    });
    expect(identify(req({ ip: '203.0.113.9' }))).toMatchObject({
      key: 'ip:203.0.113.9',
      tier: 'unauthenticated',
    });
  });
});

describe('clientIpHeader', () => {
  const withHeader = (value: string | undefined, ip = '::ffff:10.0.0.1') =>
    req({
      ip,
      get: (name: string) => (name.toLowerCase() === 'fly-client-ip' ? value : undefined),
    });

  it('takes the client address from a trusted platform header when configured', () => {
    const identify = identifyByUserOrIp({ clientIpHeader: 'Fly-Client-IP' });
    expect(identify(withHeader('203.0.113.9'))).toEqual({
      key: 'ip:203.0.113.9',
      tier: 'unauthenticated',
      ip: '203.0.113.9',
    });
    expect(identify(withHeader('::ffff:203.0.113.9'))).toMatchObject({ ip: '203.0.113.9' });
  });

  it('falls back to the socket address when the header is missing or blank', () => {
    const identify = identifyByUserOrIp({ clientIpHeader: 'Fly-Client-IP' });
    expect(identify(withHeader(undefined))).toMatchObject({ key: 'ip:10.0.0.1' });
    expect(identify(withHeader('  '))).toMatchObject({ key: 'ip:10.0.0.1' });
  });

  it('uses the first address when the header carries a list', () => {
    const identify = identifyByIp({ clientIpHeader: 'Fly-Client-IP' });
    expect(identify(withHeader('203.0.113.9, 198.51.100.1'))).toMatchObject({
      key: 'ip:203.0.113.9',
      ip: '203.0.113.9',
    });
  });

  it('still records the user id for authenticated requests', () => {
    const identify = identifyByUserOrIp({ clientIpHeader: 'Fly-Client-IP' });
    expect(
      identify(req({ ip: '10.0.0.1', user: { id: 'alice' }, get: () => '203.0.113.9' })),
    ).toEqual({
      key: 'user:alice',
      tier: 'authenticated',
      userId: 'alice',
      ip: '203.0.113.9',
    });
  });
});
