/** Error codes shared by the WebSocket `error` frame and the HTTP error mapping. */
export type ChatErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_joined'
  | 'rate_limited'
  | 'banned'
  | 'conflict'
  | 'validation'
  | 'internal';

export class ChatError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly code: ChatErrorCode,
    message: string,
    options: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ChatError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

export const HTTP_STATUS_BY_CODE: Record<ChatErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  not_joined: 403,
  rate_limited: 429,
  banned: 403,
  conflict: 409,
  validation: 400,
  internal: 500,
};
