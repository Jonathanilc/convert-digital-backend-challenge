import { createPathMatcher } from './path-matcher.js';
import {
  ALGORITHMS,
  type Algorithm,
  type EndpointRule,
  type Limit,
  type Tier,
  type TierLimits,
} from './types.js';

export const DEFAULT_RULE_ID = 'default';

export interface CompiledRule {
  id: string;
  matches: (path: string, method: string) => boolean;
  limits: Partial<TierLimits>;
  algorithm?: Algorithm;
}

export function assertLimit(limit: Limit, label: string): void {
  if (!Number.isInteger(limit.limit) || limit.limit < 0) {
    throw new Error(`${label}: "limit" must be a non-negative integer (got ${limit.limit})`);
  }
  if (!Number.isFinite(limit.windowMs) || limit.windowMs <= 0) {
    throw new Error(`${label}: "windowMs" must be a positive number (got ${limit.windowMs})`);
  }
}

export function assertAlgorithm(algorithm: unknown, label: string): asserts algorithm is Algorithm {
  if (!ALGORITHMS.includes(algorithm as Algorithm)) {
    throw new Error(`${label}: unknown algorithm "${String(algorithm)}"`);
  }
}

export function assertTierLimits(limits: TierLimits): void {
  if (!limits?.unauthenticated || !limits?.authenticated) {
    throw new Error('limits must define both "unauthenticated" and "authenticated" tiers');
  }
  for (const [tier, limit] of Object.entries(limits)) assertLimit(limit, `limits.${tier}`);
}

export function compileRules(rules: EndpointRule[]): CompiledRule[] {
  const seen = new Set<string>();
  return rules.map((rule, index) => {
    const label = `endpoints[${index}]`;
    const id = rule.id ?? (rule.path instanceof RegExp ? rule.path.source : rule.path);
    if (id === DEFAULT_RULE_ID)
      throw new Error(`${label}: "${DEFAULT_RULE_ID}" is a reserved rule id`);
    if (seen.has(id)) throw new Error(`${label}: duplicate rule id "${id}"`);
    seen.add(id);

    const limits = rule.limits ?? {};
    for (const [tier, limit] of Object.entries(limits)) {
      if (limit) assertLimit(limit, `${label}.limits.${tier}`);
    }
    if (rule.algorithm !== undefined) assertAlgorithm(rule.algorithm, label);

    const pathMatches = createPathMatcher(rule.path);
    const methods = rule.methods?.map((m) => m.toUpperCase());

    return {
      id,
      limits,
      algorithm: rule.algorithm,
      matches: (path, method) =>
        (methods === undefined || methods.includes(method.toUpperCase())) && pathMatches(path),
    };
  });
}

/**
 * Picks the limit for a tier: the rule's own limit first, then the global default for that
 * tier. Unknown custom tiers inherit the `authenticated` default: a caller that assigned a
 * custom tier has, by definition, identified the client.
 */
export function resolveLimit(
  tier: Tier,
  rule: CompiledRule | undefined,
  defaults: TierLimits,
): Limit {
  const fallback = tier === 'unauthenticated' ? defaults.unauthenticated : defaults.authenticated;
  return rule?.limits[tier] ?? defaults[tier] ?? fallback;
}
