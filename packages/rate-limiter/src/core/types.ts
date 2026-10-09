/**
 * Shared types for the rate limiter core.
 *
 * The core is deliberately framework-agnostic: it reasons about an {@link Identity}
 * plus a path/method, and talks to a {@link RateLimitStore}. The Express middleware
 * in `src/express` is a thin adapter on top of it, which keeps the same engine usable
 * for non-HTTP traffic (for example WebSocket message throttling).
 */

/** Algorithms every store implementation must support. */
export type Algorithm = 'fixed-window' | 'sliding-log';

export const ALGORITHMS: readonly Algorithm[] = ['fixed-window', 'sliding-log'];

export interface Limit {
  /** Maximum number of requests permitted within one window. `0` blocks everything. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface ConsumeOptions extends Limit {
  algorithm: Algorithm;
}

export interface ConsumeResult {
  /** Whether the request that was just consumed is within the limit. */
  allowed: boolean;
  /** Requests recorded in the current window, including this one when allowed. */
  count: number;
  /**
   * Milliseconds until capacity is next freed.
   * Fixed window: time until the window resets. Sliding log: time until the oldest entry expires.
   */
  resetMs: number;
}

/**
 * Storage backend. Implementations must make `consume` atomic for a given key so that
 * concurrent requests cannot exceed the limit (the Redis store uses Lua scripts for this).
 */
export interface RateLimitStore {
  consume(key: string, options: ConsumeOptions): Promise<ConsumeResult>;
  reset(key: string): Promise<void>;
  close?(): Promise<void>;
}

/** Built-in tiers. Any other string is accepted so callers can add tiers such as `premium`. */
export type Tier = 'unauthenticated' | 'authenticated' | (string & {});

export interface TierLimits {
  unauthenticated: Limit;
  authenticated: Limit;
  [tier: string]: Limit;
}

/** Per-endpoint configuration. The first rule whose path and method match wins. */
export interface EndpointRule {
  /** Identifier used in storage keys and override criteria. Defaults to the path pattern. */
  id?: string;
  /**
   * Express-style path pattern (`/api/search`, `/users/:id`, `/files/*rest`) or a RegExp.
   * Matched against the full request path (mount path + route path, no query string).
   */
  path: string | RegExp;
  /** HTTP methods this rule applies to (case-insensitive). Omit for all methods. */
  methods?: string[];
  /** Tier limits for this endpoint. Tiers that are omitted inherit the default limits. */
  limits?: Partial<TierLimits>;
  /** Algorithm for this endpoint. Omit to use the limiter default. */
  algorithm?: Algorithm;
}

/** Who is making the request, as decided by the caller (middleware). */
export interface Identity {
  /** Stable subject identifier that counters are keyed on, e.g. `ip:1.2.3.4` or `user:42`. */
  key: string;
  tier: Tier;
  userId?: string;
  ip?: string;
}

export interface RateLimitRequest {
  identity: Identity;
  /** Full request path without query string. */
  path: string;
  method: string;
}

export interface AppliedOverride {
  id: string;
  reason: string;
}

export interface Decision {
  allowed: boolean;
  /** Effective limit after overrides. */
  limit: number;
  remaining: number;
  /** Milliseconds until capacity is next freed. */
  resetMs: number;
  /** Milliseconds the client should wait before retrying; `null` when allowed. */
  retryAfterMs: number | null;
  windowMs: number;
  algorithm: Algorithm;
  /** `default` or the matched endpoint rule id. */
  ruleId: string;
  tier: Tier;
  /** Storage key the decision was made against (useful for tests and manual resets). */
  key: string;
  override?: AppliedOverride;
  /**
   * Set when the store (or override provider) failed and the configured failure policy
   * decided the outcome instead of real counts.
   */
  degraded?: boolean;
}

/** What to do when the store is unreachable. */
export type FailurePolicy = 'open' | 'closed';

export interface RateLimiterOptions {
  store: RateLimitStore;
  /** Default limits per tier, used when no endpoint rule matches or a rule omits a tier. */
  limits: TierLimits;
  /** Default algorithm. Defaults to `fixed-window`. */
  algorithm?: Algorithm;
  endpoints?: EndpointRule[];
  overrides?: OverrideProvider;
  /** Prefix for storage keys. Defaults to `rl`. */
  keyPrefix?: string;
  /** Defaults to `open`: when the store is down, requests are allowed through. */
  failurePolicy?: FailurePolicy;
  /** Called whenever the store or override provider throws. */
  onStoreError?: (error: unknown, request: RateLimitRequest) => void;
  /** Clock, injectable for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Temporary overrides
// ---------------------------------------------------------------------------

/**
 * Who an override applies to. Every provided field must match (logical AND);
 * an empty object matches every request (a global override, e.g. a launch-day event).
 */
export interface OverrideCriteria {
  userIds?: string[];
  ips?: string[];
  tiers?: Tier[];
  /** Endpoint rule ids, including `default`. */
  ruleIds?: string[];
  /** Path patterns (same syntax as {@link EndpointRule.path}, strings only). */
  paths?: string[];
}

export interface OverrideEffect {
  /** Skip rate limiting entirely for matching requests. */
  bypass?: boolean;
  /** Replace the limit. Applied before `multiplier`. */
  limit?: number;
  /** Scale the limit (e.g. `2` doubles it, `0.5` halves it). Result is floored. */
  multiplier?: number;
  windowMs?: number;
  algorithm?: Algorithm;
}

export interface Override {
  id: string;
  /** Human-readable justification, e.g. "Black Friday" or "support ticket #123". */
  reason: string;
  criteria: OverrideCriteria;
  effect: OverrideEffect;
  /** Epoch milliseconds. Overrides are temporary by construction; this field is required. */
  expiresAt: number;
  /** Optional scheduled start (epoch ms) so an event can be configured ahead of time. */
  startsAt?: number;
  /** Epoch milliseconds. Used to break ties between equally specific overrides. */
  createdAt: number;
}

export interface OverrideContext {
  identity: Identity;
  ruleId: string;
  path: string;
  method: string;
  now: number;
}

/** Read side used by the limiter on every request. */
export interface OverrideProvider {
  resolve(context: OverrideContext): Promise<Override | undefined>;
}

/** Full management API, used by admin tooling. */
export interface OverrideStore extends OverrideProvider {
  list(): Promise<Override[]>;
  put(override: Override): Promise<void>;
  remove(id: string): Promise<boolean>;
  close?(): Promise<void>;
}
