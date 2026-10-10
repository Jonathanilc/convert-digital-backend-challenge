import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, RequestHandler } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { ChatError } from '../core/errors.js';
import type { User, UserRecord } from '../core/types.js';
import type { ChatRepository } from '../store/repository.js';
import { sendError } from './errors.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by {@link resolveBearerToken} for a valid, non-banned token. */
    user?: UserRecord;
  }
  interface Locals {
    authError?: { status: number; message: string };
  }
}

// ---- passwords (Node crypto only) --------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), 64);
  const expectedBuffer = Buffer.from(expected, 'base64url');
  return key.length === expectedBuffer.length && timingSafeEqual(key, expectedBuffer);
}

// ---- tokens (HS256 JWT) ------------------------------------------------------------------

export interface TokenOptions {
  secret: string;
  ttlSeconds: number;
  now: () => number;
}

export async function issueToken(user: User, options: TokenOptions): Promise<string> {
  const issuedAt = Math.floor(options.now() / 1000);
  return new SignJWT({ username: user.username, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + options.ttlSeconds)
    .sign(new TextEncoder().encode(options.secret));
}

/** Returns the user id for a valid, unexpired token; undefined otherwise (never throws). */
export async function verifyToken(
  token: string,
  options: TokenOptions,
): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(options.secret), {
      algorithms: ['HS256'],
      currentDate: new Date(options.now()),
    });
    return typeof payload.sub === 'string' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/** Extracts a bearer token from the Authorization header, or undefined. */
export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token, ...rest] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token && rest.length === 0 ? token : undefined;
}

/**
 * Resolves the token to a user record. Validity and bans are enforced for both HTTP and
 * WebSocket upgrades through this one function.
 */
export async function authenticateToken(
  token: string | undefined,
  repository: ChatRepository,
  options: TokenOptions,
): Promise<{ user: UserRecord } | { error: { status: number; message: string } } | undefined> {
  if (token === undefined) return undefined;
  const userId = await verifyToken(token, options);
  const user = userId ? await repository.findUserById(userId) : undefined;
  if (!user) return { error: { status: 401, message: 'Invalid or expired token' } };
  if (user.bannedAt !== null) return { error: { status: 403, message: 'This account is banned' } };
  return { user };
}

// ---- express middleware ------------------------------------------------------------------

/** Resolves credentials without rejecting, so the rate limiter still counts the request. */
export function resolveBearerToken(
  repository: ChatRepository,
  options: TokenOptions,
): RequestHandler {
  return async (req, res, next) => {
    const result = await authenticateToken(
      bearerFromHeader(req.headers.authorization),
      repository,
      options,
    );
    if (result && 'user' in result) req.user = result.user;
    else if (result) res.locals.authError = result.error;
    next();
  };
}

export const rejectInvalidCredentials: RequestHandler = (_req, res, next) => {
  if (res.locals.authError) {
    sendError(res, res.locals.authError.status, res.locals.authError.message);
    return;
  }
  next();
};

/** OpenAPI security handler for `bearerAuth`. */
export const bearerAuthHandler = (req: Request): boolean => req.user !== undefined;

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    next(new ChatError('forbidden', 'Admin role required'));
    return;
  }
  next();
};
