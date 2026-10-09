import type { Request, RequestHandler } from 'express';
import { sendError } from './errors.js';

export interface DemoUser {
  id: string;
  password: string;
  token: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by {@link resolveBearerToken} when a valid token is presented. */
    user?: { id: string };
  }
  interface Locals {
    /** Set when a token was presented but is not valid; enforced after rate limiting. */
    authError?: string;
  }
}

/**
 * Resolves `Authorization: Bearer <token>` to `req.user`. It rejects nothing itself so the
 * rate limiter can count the request first; {@link rejectInvalidCredentials} does the 401.
 */
export function resolveBearerToken(users: DemoUser[]): RequestHandler {
  const byToken = new Map(users.map((u) => [u.token, u]));
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (header !== undefined) {
      const [scheme, token, ...rest] = header.split(' ');
      const user =
        scheme?.toLowerCase() === 'bearer' && token && rest.length === 0
          ? byToken.get(token)
          : undefined;
      if (user) req.user = { id: user.id };
      else res.locals.authError = 'Invalid bearer token';
    }
    next();
  };
}

export const rejectInvalidCredentials: RequestHandler = (_req, res, next) => {
  if (res.locals.authError) {
    sendError(res, 401, res.locals.authError);
    return;
  }
  next();
};

/** Security handler for the OpenAPI `bearerAuth` scheme: a resolved user must be present. */
export function bearerAuthHandler(req: Request): boolean {
  return req.user !== undefined;
}

/** Security handler for the OpenAPI `adminToken` scheme. Wrong token → 403, missing → 401. */
export function adminTokenHandler(expected: string): (req: Request) => boolean {
  return (req) => {
    const presented = req.headers['x-admin-token'];
    if (presented === undefined) return false; // validator answers 401
    if (presented !== expected)
      throw Object.assign(new Error('Invalid admin token'), { status: 403 });
    return true;
  };
}

export function authenticate(
  users: DemoUser[],
  username: string,
  password: string,
): DemoUser | undefined {
  return users.find((u) => u.id === username && u.password === password);
}
