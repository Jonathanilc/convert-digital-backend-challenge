import { monotonicFactory } from 'ulid';

/** Deterministic, strictly increasing ULIDs for a fake clock. */
export function idFactory(now: () => number): () => string {
  const next = monotonicFactory();
  return () => next(now());
}
