// Core engine
export { RateLimiter, DEGRADED_RETRY_MS } from './core/rate-limiter.js';
export { createPathMatcher } from './core/path-matcher.js';
export { ALGORITHMS } from './core/types.js';
export type {
  Algorithm,
  AppliedOverride,
  ConsumeOptions,
  ConsumeResult,
  Decision,
  EndpointRule,
  FailurePolicy,
  Identity,
  Limit,
  Override,
  OverrideContext,
  OverrideCriteria,
  OverrideEffect,
  OverrideProvider,
  OverrideStore,
  RateLimiterOptions,
  RateLimitRequest,
  RateLimitStore,
  Tier,
  TierLimits,
} from './core/types.js';

// Stores
export { MemoryStore, type MemoryStoreOptions } from './stores/memory-store.js';
export {
  RedisStore,
  DEFAULT_REDIS_OPTIONS,
  isRedisClient,
  type RedisStoreOptions,
} from './stores/redis-store.js';
export { FIXED_WINDOW_SCRIPT, SLIDING_LOG_SCRIPT } from './stores/lua-scripts.js';

// Temporary overrides
export { MemoryOverrideStore } from './overrides/memory-override-store.js';
export {
  RedisOverrideStore,
  type RedisOverrideStoreOptions,
} from './overrides/redis-override-store.js';
export { pickOverride, overrideMatches, specificity, validateOverride } from './overrides/match.js';

// Express adapter
export { rateLimit, requestPath, type RateLimitMiddlewareOptions } from './express/middleware.js';
export {
  identifyByUserOrIp,
  identifyByIp,
  normalizeIp,
  type Identify,
  type IdentifyOptions,
} from './express/identify.js';
export { applyRateLimitHeaders, retryAfterSeconds, type HeaderStyle } from './express/headers.js';
