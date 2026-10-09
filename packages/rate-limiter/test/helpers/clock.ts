export interface FakeClock {
  now: () => number;
  advance(ms: number): void;
  set(ms: number): void;
}

/** Deterministic clock. Starts at an arbitrary epoch so timestamps look realistic. */
export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}
