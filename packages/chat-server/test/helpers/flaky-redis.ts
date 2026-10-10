/**
 * Wraps a Redis client so an outage can be simulated at will. While `down` is true every
 * command rejects the way ioredis does when the connection is gone. Lifecycle methods keep
 * working so tests can still clean up.
 */
export interface FlakyRedis<T> {
  client: T;
  down: boolean;
}

const ALWAYS_UP = new Set<PropertyKey>([
  'quit',
  'disconnect',
  'on',
  'once',
  'off',
  'defineCommand',
  'scan',
  'del',
]);

export function flakyRedis<T extends object>(target: T): FlakyRedis<T> {
  const state = { down: false };
  const client = new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (state.down && !ALWAYS_UP.has(prop)) {
          return Promise.reject(new Error('Connection is closed.'));
        }
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  }) as T;

  return {
    client,
    get down() {
      return state.down;
    },
    set down(value: boolean) {
      state.down = value;
    },
  };
}
