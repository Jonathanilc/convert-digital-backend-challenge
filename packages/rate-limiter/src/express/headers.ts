import type { Response } from 'express';
import type { Decision } from '../core/types.js';

/**
 * `standard` emits the IETF RateLimit fields (draft-ietf-httpapi-ratelimit-headers), `legacy`
 * the de-facto `X-RateLimit-*` trio, `both` emits both, `none` disables them.
 */
export type HeaderStyle = 'standard' | 'legacy' | 'both' | 'none';

export function retryAfterSeconds(decision: Decision): number {
  return Math.max(1, Math.ceil((decision.retryAfterMs ?? 0) / 1000));
}

export function applyRateLimitHeaders(res: Response, decision: Decision, style: HeaderStyle): void {
  // A degraded decision carries no real counts; advertising invented numbers would mislead clients.
  if (style === 'none' || decision.degraded) return;

  const resetSeconds = Math.max(0, Math.ceil(decision.resetMs / 1000));

  if (style === 'standard' || style === 'both') {
    res.setHeader('RateLimit-Limit', String(decision.limit));
    res.setHeader('RateLimit-Remaining', String(decision.remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    res.setHeader('RateLimit-Policy', `${decision.limit};w=${Math.ceil(decision.windowMs / 1000)}`);
  }

  if (style === 'legacy' || style === 'both') {
    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + decision.resetMs) / 1000)));
  }

  if (!decision.allowed && decision.retryAfterMs !== null) {
    res.setHeader('Retry-After', String(retryAfterSeconds(decision)));
  }
}
