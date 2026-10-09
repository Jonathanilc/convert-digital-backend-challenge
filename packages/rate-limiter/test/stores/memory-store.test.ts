import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { fakeClock } from '../helpers/clock.js';
import { runStoreContract } from './store-contract.js';

runStoreContract('MemoryStore', (clock) => new MemoryStore({ now: clock.now, sweepIntervalMs: 0 }));

describe('MemoryStore: housekeeping', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sweeps expired fixed-window entries on the configured interval', async () => {
    const clock = fakeClock();
    const store = new MemoryStore({ now: clock.now, sweepIntervalMs: 1_000 });
    await store.consume('a', { limit: 5, windowMs: 500, algorithm: 'fixed-window' });
    await store.consume('b', { limit: 5, windowMs: 5_000, algorithm: 'fixed-window' });
    expect(store.size).toBe(2);

    clock.advance(1_000);
    vi.advanceTimersByTime(1_000);
    expect(store.size).toBe(1);
    await store.close();
  });

  it('close() stops the sweeper and clears all state', async () => {
    const store = new MemoryStore({ sweepIntervalMs: 1_000 });
    await store.consume('a', { limit: 5, windowMs: 500, algorithm: 'sliding-log' });
    await store.close();
    expect(store.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
