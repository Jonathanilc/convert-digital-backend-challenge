import type { Request, RequestHandler, Response } from 'express';
import type { RateLimiter } from '../core/rate-limiter.js';
import type { Decision } from '../core/types.js';
import { applyRateLimitHeaders, retryAfterSeconds, type HeaderStyle } from './headers.js';
import { identifyByUserOrIp, type Identify } from './identify.js';

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  /** How to derive the subject and tier of a request. Defaults to {@link identifyByUserOrIp}. */
  identify?: Identify;
  /** Return `true` to exempt a request (health checks, internal callers, ...). */
  skip?: (req: Request) => boolean | Promise<boolean>;
  /** Defaults to `standard`. */
  headers?: HeaderStyle;
  /** Replace the default 429 JSON response. Headers are already set when this runs. */
  onLimited?: (req: Request, res: Response, decision: Decision) => void;
  /** Message in the default 429 body. */
  message?: string;
}

declare module 'express-serve-static-core' {
  interface Locals {
    /** The decision made for this request, for downstream handlers and logging. */
    rateLimit?: Decision;
  }
}

/** Full path of the request regardless of where the middleware is mounted. */
export function requestPath(req: Request): string {
  return `${req.baseUrl ?? ''}${req.path}` || '/';
}

export function rateLimit(options: RateLimitMiddlewareOptions): RequestHandler {
  const identify = options.identify ?? identifyByUserOrIp();
  const headers = options.headers ?? 'standard';
  const message = options.message ?? 'Too many requests, please try again later.';

  return async function rateLimitMiddleware(req, res, next) {
    try {
      if (options.skip && (await options.skip(req))) {
        next();
        return;
      }

      const identity = identify(req);
      const decision = await options.limiter.check({
        identity,
        path: requestPath(req),
        method: req.method,
      });

      res.locals.rateLimit = decision;
      applyRateLimitHeaders(res, decision, headers);

      if (decision.allowed) {
        next();
        return;
      }

      if (decision.degraded) {
        // Failing closed: the limit could not be evaluated, which is a server-side fault.
        res.setHeader('Retry-After', String(retryAfterSeconds(decision)));
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Rate limiter backend is unavailable.',
          retryAfterSeconds: retryAfterSeconds(decision),
        });
        return;
      }

      if (options.onLimited) {
        options.onLimited(req, res, decision);
        return;
      }

      res.status(429).json({
        error: 'Too Many Requests',
        message,
        limit: decision.limit,
        remaining: 0,
        retryAfterSeconds: retryAfterSeconds(decision),
        ...(decision.override ? { override: decision.override.id } : {}),
      });
    } catch (error) {
      next(error);
    }
  };
}
