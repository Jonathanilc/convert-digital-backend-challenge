import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RateLimitStore } from '../../src/core/types.js';
import { fakeClock, type FakeClock } from '../helpers/clock.js';

export interface StoreFactory {
  (clock: FakeClock): Promise<RateLimitStore> | RateLimitStore;
}

let keyCounter = 0;
const uniqueKey = (label: string) => `contract:${label}:${Date.now()}:${keyCounter++}`;

/**
 * Behavioural contract every RateLimitStore must satisfy. Running the same suite against the
 * memory store, ioredis-mock and real Redis is what lets the app treat them as interchangeable.
 */
export function runStoreContract(name: string, makeStore: StoreFactory): void {
  describe(`${name}: RateLimitStore contract`, () => {
    let clock: FakeClock;
    let store: RateLimitStore;

    beforeEach(async () => {
      clock = fakeClock();
      store = await makeStore(clock);
    });

    afterEach(async () => {
      await store.close?.();
    });

    describe('fixed-window', () => {
      const opts = { limit: 3, windowMs: 1_000, algorithm: 'fixed-window' as const };

      it('allows requests up to the limit and denies the next one', async () => {
        const key = uniqueKey('fw');
        const results = [];
        for (let i = 0; i < 4; i++) results.push(await store.consume(key, opts));

        expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
        expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
      });

      it('reports resetMs counting down to the end of the window', async () => {
        const key = uniqueKey('fw');
        expect((await store.consume(key, opts)).resetMs).toBe(1_000);
        clock.advance(400);
        expect((await store.consume(key, opts)).resetMs).toBe(600);
      });

      it('starts a fresh window once the previous one has elapsed', async () => {
        const key = uniqueKey('fw');
        for (let i = 0; i < 3; i++) await store.consume(key, opts);
        expect((await store.consume(key, opts)).allowed).toBe(false);

        clock.advance(1_000);
        const fresh = await store.consume(key, opts);
        expect(fresh).toEqual({ allowed: true, count: 1, resetMs: 1_000 });
      });

      it('keeps counters isolated per key', async () => {
        const a = uniqueKey('fw-a');
        const b = uniqueKey('fw-b');
        for (let i = 0; i < 3; i++) await store.consume(a, opts);
        expect((await store.consume(a, opts)).allowed).toBe(false);
        expect((await store.consume(b, opts)).allowed).toBe(true);
      });

      it('treats a limit of 0 as block-all', async () => {
        const result = await store.consume(uniqueKey('fw-zero'), { ...opts, limit: 0 });
        expect(result.allowed).toBe(false);
      });
    });

    describe('sliding-log', () => {
      const opts = { limit: 2, windowMs: 1_000, algorithm: 'sliding-log' as const };

      it('allows up to the limit inside any trailing window', async () => {
        const key = uniqueKey('sl');
        expect((await store.consume(key, opts)).allowed).toBe(true);
        clock.advance(400);
        expect((await store.consume(key, opts)).allowed).toBe(true);
        clock.advance(100);
        expect(await store.consume(key, opts)).toEqual({ allowed: false, count: 2, resetMs: 500 });
      });

      it('frees exactly one slot when the oldest entry ages out (true sliding behaviour)', async () => {
        const key = uniqueKey('sl');
        await store.consume(key, opts); // t=0
        clock.advance(400);
        await store.consume(key, opts); // t=400
        clock.advance(600); // t=1000: the t=0 entry has aged out, t=400 has not

        expect(await store.consume(key, opts)).toEqual({ allowed: true, count: 2, resetMs: 400 });
        expect((await store.consume(key, opts)).allowed).toBe(false);
      });

      it('does not record denied requests, so retrying while blocked does not extend the lock-out', async () => {
        const key = uniqueKey('sl');
        await store.consume(key, opts);
        await store.consume(key, opts);
        clock.advance(900);
        expect((await store.consume(key, opts)).allowed).toBe(false); // denied at t=900
        clock.advance(100); // t=1000: both originals expired; the denied hit must not count
        const result = await store.consume(key, opts);
        expect(result).toEqual({ allowed: true, count: 1, resetMs: 1_000 });
      });

      it('reports resetMs as the time until the oldest entry expires', async () => {
        const key = uniqueKey('sl');
        await store.consume(key, opts); // oldest at t=0
        clock.advance(250);
        expect((await store.consume(key, opts)).resetMs).toBe(750);
      });

      it('treats a limit of 0 as block-all', async () => {
        const result = await store.consume(uniqueKey('sl-zero'), { ...opts, limit: 0 });
        expect(result.allowed).toBe(false);
        expect(result.count).toBe(0);
      });
    });

    describe('reset', () => {
      it('clears a key for both algorithms', async () => {
        const fw = uniqueKey('reset-fw');
        const sl = uniqueKey('reset-sl');
        const fwOpts = { limit: 1, windowMs: 1_000, algorithm: 'fixed-window' as const };
        const slOpts = { limit: 1, windowMs: 1_000, algorithm: 'sliding-log' as const };

        await store.consume(fw, fwOpts);
        await store.consume(sl, slOpts);
        expect((await store.consume(fw, fwOpts)).allowed).toBe(false);
        expect((await store.consume(sl, slOpts)).allowed).toBe(false);

        await store.reset(fw);
        await store.reset(sl);
        expect((await store.consume(fw, fwOpts)).allowed).toBe(true);
        expect((await store.consume(sl, slOpts)).allowed).toBe(true);
      });
    });

    describe('atomicity', () => {
      it.each(['fixed-window', 'sliding-log'] as const)(
        'admits exactly `limit` requests out of 50 concurrent ones (%s)',
        async (algorithm) => {
          const key = uniqueKey(`concurrent-${algorithm}`);
          const results = await Promise.all(
            Array.from({ length: 50 }, () =>
              store.consume(key, { limit: 10, windowMs: 10_000, algorithm }),
            ),
          );
          expect(results.filter((r) => r.allowed)).toHaveLength(10);
        },
      );
    });
  });
}
