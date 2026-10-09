import type { ErrorRequestHandler, Response } from 'express';
import type { Logger as PinoLogger } from 'pino';
import type { components } from './generated/openapi.js';

export type ApiError = components['schemas']['Error'];

/** Structured logger. pino's API: `logger.info({ ...fields }, 'message')`. */
export type Logger = PinoLogger;

export const REASON_PHRASES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** An error that already knows which HTTP status and message it should produce. */
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

/**
 * Single error handler: maps our own HttpError, express-openapi-validator errors
 * (`{ status, message, errors: [{ path, message }] }`) and body-parser errors onto the
 * contract's `Error` schema. Anything else is a 500 with the detail kept server-side.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const e = (err ?? {}) as ErrorLike;
    const status =
      typeof e.status === 'number' && e.status >= 400 && e.status <= 599 ? e.status : 500;

    let details: ApiError['details'];
    if (Array.isArray(e.details)) details = e.details as ApiError['details'];
    else if (Array.isArray(e.errors)) {
      details = e.errors.map((item) => ({
        path: String(item.path ?? ''),
        message: String(item.message ?? ''),
      }));
    }

    if (status >= 500) logger.error({ err }, 'request failed');
    const message =
      status >= 500 ? 'Internal Server Error' : String(e.message ?? REASON_PHRASES[status]);
    sendError(res, status, message, details);
  };
}
