import type { Request } from 'express';
import type { Identity } from '../core/types.js';

export type Identify = (req: Request) => Identity;

export interface IdentifyOptions {
  /**
   * Extracts the authenticated user's id. The default reads `req.user.id`, which is where
   * most auth middleware (Passport, custom JWT guards) puts it.
   */
  getUserId?: (req: Request) => string | undefined;
  /**
   * Name of a header the hosting platform sets with the real client address and that clients
   * cannot forge, e.g. `Fly-Client-IP` or `CF-Connecting-IP`. When present it takes precedence
   * over `req.ip`; when absent or blank, `req.ip` is used. Prefer this over `trust proxy` hop
   * counting whenever the platform offers such a header.
   */
  clientIpHeader?: string;
}

/** Express reports IPv4 clients on dual-stack sockets as `::ffff:a.b.c.d`; strip the prefix. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

/** Resolves the client address: trusted platform header first, then Express's `req.ip`. */
export function clientIp(req: Request, header?: string): string {
  if (header) {
    const raw = req.get(header);
    const first = raw?.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.ip);
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
    const ip = clientIp(req, options.clientIpHeader);
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
    const ip = clientIp(req, options.clientIpHeader);
    const userId = getUserId(req);
    return {
      key: `ip:${ip}`,
      tier: userId !== undefined ? 'authenticated' : 'unauthenticated',
      ...(userId !== undefined ? { userId } : {}),
      ip,
    };
  };
}
