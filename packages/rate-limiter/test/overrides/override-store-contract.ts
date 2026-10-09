import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OverrideStore } from '../../src/core/types.js';
import { fakeClock, type FakeClock } from '../helpers/clock.js';
import { anon, ctx, makeOverride, T0 } from './fixtures.js';

export interface OverrideStoreFactory {
  (clock: FakeClock): Promise<OverrideStore> | OverrideStore;
}

/** Behaviour every OverrideStore must share so the app can swap memory and Redis freely. */
export function runOverrideStoreContract(name: string, makeStore: OverrideStoreFactory): void {
  describe(`${name}: OverrideStore contract`, () => {
    let clock: FakeClock;
    let store: OverrideStore;

    beforeEach(async () => {
      clock = fakeClock(T0);
      store = await makeStore(clock);
    });

    afterEach(async () => {
      await store.close?.();
    });

    it('lists stored overrides newest first', async () => {
      await store.put(makeOverride({ id: 'a', createdAt: T0 - 3_000 }));
      await store.put(makeOverride({ id: 'b', createdAt: T0 - 1_000 }));
      expect((await store.list()).map((o) => o.id)).toEqual(['b', 'a']);
    });

    it('omits expired overrides from list and resolve', async () => {
      await store.put(makeOverride({ id: 'short', expiresAt: T0 + 100 }));
      await store.put(makeOverride({ id: 'long', expiresAt: T0 + 10_000 }));
      clock.advance(200);
      expect((await store.list()).map((o) => o.id)).toEqual(['long']);
      expect((await store.resolve(ctx({ now: clock.now() })))?.id).toBe('long');
    });

    it('resolves the best matching active override', async () => {
      await store.put(makeOverride({ id: 'global' }));
      await store.put(makeOverride({ id: 'alice', criteria: { userIds: ['alice'] } }));
      expect((await store.resolve(ctx()))?.id).toBe('alice');
      expect((await store.resolve(ctx({ identity: anon })))?.id).toBe('global');
    });

    it('resolves to undefined when nothing applies', async () => {
      await store.put(makeOverride({ id: 'alice', criteria: { userIds: ['alice'] } }));
      expect(await store.resolve(ctx({ identity: anon }))).toBeUndefined();
    });

    it('replaces an override that has the same id', async () => {
      await store.put(makeOverride({ id: 'a', effect: { multiplier: 2 } }));
      await store.put(makeOverride({ id: 'a', effect: { multiplier: 3 } }));
      const all = await store.list();
      expect(all).toHaveLength(1);
      expect(all[0]?.effect).toEqual({ multiplier: 3 });
    });

    it('reports whether remove deleted anything', async () => {
      await store.put(makeOverride({ id: 'a' }));
      expect(await store.remove('a')).toBe(true);
      expect(await store.remove('a')).toBe(false);
      expect(await store.list()).toEqual([]);
    });

    it('rejects invalid overrides on put', async () => {
      await expect(store.put(makeOverride({ effect: {} }))).rejects.toThrow(/at least one effect/);
      expect(await store.list()).toEqual([]);
    });
  });
}
