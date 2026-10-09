import { describe, expect, it } from 'vitest';
import { MemoryOverrideStore } from '../../src/overrides/memory-override-store.js';
import { fakeClock } from '../helpers/clock.js';
import { makeOverride, T0 } from './fixtures.js';
import { runOverrideStoreContract } from './override-store-contract.js';

runOverrideStoreContract(
  'MemoryOverrideStore',
  (clock) => new MemoryOverrideStore({ now: clock.now }),
);

describe('MemoryOverrideStore: housekeeping', () => {
  it('drops expired overrides when they are next read', async () => {
    const clock = fakeClock(T0);
    const store = new MemoryOverrideStore({ now: clock.now });
    await store.put(makeOverride({ id: 'a', expiresAt: T0 + 10 }));
    expect(store.size).toBe(1);
    clock.advance(20);
    await store.list();
    expect(store.size).toBe(0);
  });
});
