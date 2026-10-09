import { match } from 'path-to-regexp';

export type PathMatcher = (path: string) => boolean;

/**
 * Compiles an Express-style pattern (path-to-regexp v8 syntax, the same one Express 5 uses)
 * or a RegExp into a predicate. Invalid patterns fail at configuration time rather than
 * silently never matching.
 */
export function createPathMatcher(pattern: string | RegExp): PathMatcher {
  if (pattern instanceof RegExp) {
    // Drop global/sticky flags so `test` has no lastIndex state between calls.
    const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    return (path) => re.test(path);
  }

  let fn: ReturnType<typeof match>;
  try {
    fn = match(pattern, { decode: decodeURIComponent });
  } catch (error) {
    throw new Error(`Invalid path pattern "${pattern}": ${(error as Error).message}`);
  }

  return (path) => {
    try {
      return fn(path) !== false;
    } catch {
      // Malformed percent-encoding in the request path: not a match, not our error.
      return false;
    }
  };
}

const cache = new Map<string, PathMatcher>();

/** Cached variant for patterns that arrive at runtime (override criteria). */
export function cachedPathMatcher(pattern: string): PathMatcher {
  let matcher = cache.get(pattern);
  if (!matcher) {
    matcher = createPathMatcher(pattern);
    if (cache.size >= 1_000) cache.clear();
    cache.set(pattern, matcher);
  }
  return matcher;
}
