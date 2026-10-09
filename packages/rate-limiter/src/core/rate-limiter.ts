import {
  assertAlgorithm,
  assertTierLimits,
  compileRules,
  DEFAULT_RULE_ID,
  resolveLimit,
  type CompiledRule,
} from './policy.js';
import type {
  Algorithm,
  AppliedOverride,
  Decision,
  FailurePolicy,
  Override,
  OverrideProvider,
  RateLimiterOptions,
  RateLimitRequest,
  RateLimitStore,
  TierLimits,
} from './types.js';

/** Retry hint used when failing closed; short because such outages are usually transient. */
export const DEGRADED_RETRY_MS = 1_000;

const ALGORITHM_CODES: Record<Algorithm, string> = {
  'fixed-window': 'fw',
  'sliding-log': 'sl',
};

/**
 * Framework-agnostic rate limiting engine.
 *
 * Per request: match endpoint rule → pick the tier's limit → apply a temporary override →
 * consume from the store → translate into a {@link Decision}.
 */
export class RateLimiter {
  private readonly store: RateLimitStore;
  private readonly limits: TierLimits;
  private readonly algorithm: Algorithm;
  private readonly rules: CompiledRule[];
  private readonly overrides: OverrideProvider | undefined;
  private readonly keyPrefix: string;
  private readonly failurePolicy: FailurePolicy;
  private readonly onStoreError: RateLimiterOptions['onStoreError'];
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    assertTierLimits(options.limits);
    const algorithm = options.algorithm ?? 'fixed-window';
    assertAlgorithm(algorithm, 'algorithm');

    this.store = options.store;
    this.limits = options.limits;
    this.algorithm = algorithm;
    this.rules = compileRules(options.endpoints ?? []);
    this.overrides = options.overrides;
    this.keyPrefix = options.keyPrefix ?? 'rl';
    this.failurePolicy = options.failurePolicy ?? 'open';
    this.onStoreError = options.onStoreError;
    this.now = options.now ?? Date.now;
  }

  async check(request: RateLimitRequest): Promise<Decision> {
    const { identity, path, method } = request;
    const now = this.now();

    const rule = this.rules.find((r) => r.matches(path, method));
    const ruleId = rule?.id ?? DEFAULT_RULE_ID;
    const base = resolveLimit(identity.tier, rule, this.limits);

    let algorithm = rule?.algorithm ?? this.algorithm;
    let limit = base.limit;
    let windowMs = base.windowMs;
    let bypass = false;
    let applied: AppliedOverride | undefined;

    const override = await this.resolveOverride(request, ruleId, now);
    if (override) {
      const { effect } = override;
      applied = { id: override.id, reason: override.reason };
      if (effect.bypass) bypass = true;
      if (effect.windowMs !== undefined) windowMs = effect.windowMs;
      if (effect.limit !== undefined) limit = effect.limit;
      if (effect.multiplier !== undefined) limit = Math.floor(limit * effect.multiplier);
      if (effect.algorithm !== undefined) algorithm = effect.algorithm;
    }

    const key = this.buildKey(algorithm, ruleId, identity.key);
    const common = {
      limit,
      windowMs,
      algorithm,
      ruleId,
      tier: identity.tier,
      key,
      override: applied,
    };

    if (bypass) {
      return { ...common, allowed: true, remaining: limit, resetMs: windowMs, retryAfterMs: null };
    }

    try {
      const result = await this.store.consume(key, { limit, windowMs, algorithm });
      return {
        ...common,
        allowed: result.allowed,
        remaining: Math.max(0, limit - result.count),
        resetMs: result.resetMs,
        retryAfterMs: result.allowed ? null : result.resetMs,
      };
    } catch (error) {
      this.onStoreError?.(error, request);
      const allowed = this.failurePolicy === 'open';
      return {
        ...common,
        allowed,
        remaining: allowed ? limit : 0,
        resetMs: allowed ? windowMs : DEGRADED_RETRY_MS,
        retryAfterMs: allowed ? null : DEGRADED_RETRY_MS,
        degraded: true,
      };
    }
  }

  /** Clears the counter behind a decision, e.g. after a successful login. */
  async reset(key: string): Promise<void> {
    await this.store.reset(key);
  }

  buildKey(algorithm: Algorithm, ruleId: string, identityKey: string): string {
    // The algorithm is part of the key because the two algorithms use different Redis data
    // types; switching algorithm via an override must never produce a WRONGTYPE error.
    return `${this.keyPrefix}:${ALGORITHM_CODES[algorithm]}:${ruleId}:${identityKey}`;
  }

  private async resolveOverride(
    request: RateLimitRequest,
    ruleId: string,
    now: number,
  ): Promise<Override | undefined> {
    if (!this.overrides) return undefined;
    try {
      return await this.overrides.resolve({
        identity: request.identity,
        ruleId,
        path: request.path,
        method: request.method,
        now,
      });
    } catch (error) {
      // An override lookup failure must never take the API down; base limits apply.
      this.onStoreError?.(error, request);
      return undefined;
    }
  }
}
