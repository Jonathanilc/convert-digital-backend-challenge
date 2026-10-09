import { cachedPathMatcher } from '../core/path-matcher.js';
import { ALGORITHMS, type Override, type OverrideContext } from '../core/types.js';

export function isActive(override: Override, now: number): boolean {
  if (override.expiresAt <= now) return false;
  if (override.startsAt !== undefined && override.startsAt > now) return false;
  return true;
}

/** Every criterion present on the override must match the request (logical AND). */
export function overrideMatches(override: Override, ctx: OverrideContext): boolean {
  if (!isActive(override, ctx.now)) return false;
  const c = override.criteria;
  const { identity } = ctx;

  if (c.userIds && (identity.userId === undefined || !c.userIds.includes(identity.userId)))
    return false;
  if (c.ips && (identity.ip === undefined || !c.ips.includes(identity.ip))) return false;
  if (c.tiers && !c.tiers.includes(identity.tier)) return false;
  if (c.ruleIds && !c.ruleIds.includes(ctx.ruleId)) return false;
  if (c.paths && !c.paths.some((pattern) => cachedPathMatcher(pattern)(ctx.path))) return false;
  return true;
}

/** Number of criteria dimensions the override pins down. Higher is more specific. */
export function specificity(override: Override): number {
  return Object.values(override.criteria).filter((v) => Array.isArray(v)).length;
}

/**
 * Chooses one override among candidates: the most specific match wins (a per-user override
 * beats a global event); ties go to the most recently created one. Effects are deliberately
 * not stacked so operators can predict the outcome.
 */
export function pickOverride(
  candidates: Iterable<Override>,
  ctx: OverrideContext,
): Override | undefined {
  let best: Override | undefined;
  let bestScore = -1;
  for (const candidate of candidates) {
    if (!overrideMatches(candidate, ctx)) continue;
    const score = specificity(candidate);
    if (
      !best ||
      score > bestScore ||
      (score === bestScore && candidate.createdAt > best.createdAt)
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function validateOverride(override: Override): void {
  const fail = (message: string): never => {
    throw new Error(`Invalid override${override?.id ? ` "${override.id}"` : ''}: ${message}`);
  };

  if (typeof override.id !== 'string' || override.id.length === 0) fail('"id" is required');
  if (typeof override.reason !== 'string' || override.reason.trim().length === 0)
    fail('"reason" is required');
  if (!Number.isFinite(override.expiresAt)) fail('"expiresAt" must be an epoch-ms number');
  if (!Number.isFinite(override.createdAt)) fail('"createdAt" must be an epoch-ms number');
  if (override.startsAt !== undefined && !Number.isFinite(override.startsAt)) {
    fail('"startsAt" must be an epoch-ms number');
  }

  if (override.criteria === null || typeof override.criteria !== 'object')
    fail('"criteria" must be an object');
  for (const [name, value] of Object.entries(override.criteria)) {
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    ) {
      fail(`criteria.${name} must be an array of strings`);
    }
  }
  for (const pattern of override.criteria.paths ?? []) cachedPathMatcher(pattern); // throws if invalid

  const effect = override.effect;
  if (effect === null || typeof effect !== 'object') fail('"effect" must be an object');
  const hasEffect =
    effect.bypass !== undefined ||
    effect.limit !== undefined ||
    effect.multiplier !== undefined ||
    effect.windowMs !== undefined ||
    effect.algorithm !== undefined;
  if (!hasEffect)
    fail('at least one effect (bypass, limit, multiplier, windowMs, algorithm) is required');

  if (effect.limit !== undefined && (!Number.isInteger(effect.limit) || effect.limit < 0)) {
    fail('"limit" must be a non-negative integer');
  }
  if (
    effect.multiplier !== undefined &&
    (!Number.isFinite(effect.multiplier) || effect.multiplier < 0)
  ) {
    fail('"multiplier" must be a non-negative number');
  }
  if (
    effect.windowMs !== undefined &&
    (!Number.isFinite(effect.windowMs) || effect.windowMs <= 0)
  ) {
    fail('"windowMs" must be a positive number');
  }
  if (effect.algorithm !== undefined && !ALGORITHMS.includes(effect.algorithm)) {
    fail(`unknown algorithm "${String(effect.algorithm)}"`);
  }
}
