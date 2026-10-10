import type { ErrorRequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { ChatError, HTTP_STATUS_BY_CODE } from '../core/errors.js';
import type { components } from '../generated/openapi.js';

export type ApiError = components['schemas']['Error'];

export const REASON_PHRASES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: ApiError['details'],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function sendError(
  res: Response,
  status: number,
  message: string,
  details?: ApiError['details'],
): void {
  const body: ApiError = {
    error: REASON_PHRASES[status] ?? 'Error',
    message,
    ...(details ? { details } : {}),
  };
  res.status(status).json(body);
}

interface ErrorLike {
  status?: unknown;
  message?: unknown;
  details?: unknown;
  errors?: Array<{ path?: unknown; message?: unknown }>;
}

/** Maps ChatError, HttpError, express-openapi-validator and body-parser errors onto the Error schema. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (err instanceof ChatError) {
      if (err.retryAfterMs !== undefined)
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
      sendError(res, HTTP_STATUS_BY_CODE[err.code], err.message);
      return;
    }
    const e = (err ?? {}) as ErrorLike;
    const status =
      typeof e.status === 'number' && e.status >= 400 && e.status <= 599 ? e.status : 500;
    let details: ApiError['details'];
    if (Array.isArray(e.details)) details = e.details as ApiError['details'];
    else if (Array.isArray(e.errors))
      details = e.errors.map((i) => ({
        path: String(i.path ?? ''),
        message: String(i.message ?? ''),
      }));
    if (status >= 500) logger.error({ err }, 'request failed');
    sendError(
      res,
      status,
      status >= 500 ? 'Internal Server Error' : String(e.message ?? REASON_PHRASES[status]),
      details,
    );
  };
}
