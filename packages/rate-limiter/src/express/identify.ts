import type { Request } from 'express';
import type { Identity } from '../core/types.js';

export type Identify = (req: Request) => Identity;

export interface IdentifyOptions {
  /**
   * Extracts the authenticated user's id. The default reads `req.user.id`, which is where
   * most auth middleware (Passport, custom JWT guards) puts it.
   */
  getUserId?: (req: Request) => string | undefined;
}

/** Express reports IPv4 clients on dual-stack sockets as `::ffff:a.b.c.d`; strip the prefix. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

export function defaultGetUserId(req: Request): string | undefined {
  const user = (req as Request & { user?: unknown }).user;
  if (user && typeof user === 'object' && 'id' in user) {
    const id = (user as { id: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
    if (typeof id === 'number') return String(id);
  }
  return undefined;
}

/**
 * Default strategy: authenticated users are keyed by user id (a user on a changing IP keeps
 * one budget, many users behind one NAT do not share one); anonymous traffic is keyed by IP.
 */
export function identifyByUserOrIp(options: IdentifyOptions = {}): Identify {
  const getUserId = options.getUserId ?? defaultGetUserId;
  return (req) => {
    const ip = normalizeIp(req.ip);
    const userId = getUserId(req);
    if (userId !== undefined) return { key: `user:${userId}`, tier: 'authenticated', userId, ip };
    return { key: `ip:${ip}`, tier: 'unauthenticated', ip };
  };
}

/**
 * Strict per-IP strategy: every request is keyed by IP and authentication only changes the
 * tier, i.e. which limit applies.
 */
export function identifyByIp(options: IdentifyOptions = {}): Identify {
  const getUserId = options.getUserId ?? defaultGetUserId;
  return (req) => {
    const ip = normalizeIp(req.ip);
    const userId = getUserId(req);
    return {
      key: `ip:${ip}`,
      tier: userId !== undefined ? 'authenticated' : 'unauthenticated',
      ...(userId !== undefined ? { userId } : {}),
      ip,
    };
  };
}
