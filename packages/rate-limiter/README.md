# @challenge/rate-limiter

Rate limiting for Express 5 + TypeScript, backed by Redis.

- **Per client**: anonymous callers are tracked by IP, authenticated callers by user id.
- **Per tier**: different limits for unauthenticated (default 100/hour) and authenticated
  (default 200/hour) callers; extra tiers can be added.
- **Per endpoint**: rules with Express-style path patterns, optional method filters, their own
  limits and their own algorithm.
- **Two algorithms**: fixed window (cheap) and sliding log (exact), both atomic via Lua.
- **Temporary overrides**: raise, lower, block or bypass limits for a user, IP, tier, endpoint
  or everyone, with mandatory expiry and an admin API.
- **Standard headers**: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`,
  `RateLimit-Policy`, and `Retry-After` on `429`.
- **Resilient**: fail open (default) or fail closed (`503`) when Redis is unreachable.
- **Contract first**: the demo API is specified in [`openapi.yaml`](openapi.yaml), which also
  validates requests and responses and generates the handler types.

The design and its trade-offs are documented in [`../../docs/DESIGN.md`](../../docs/DESIGN.md).
Interactive docs (Swagger UI) are served at `/docs`; the raw document at `/openapi.json`.

## Demo API

From the repository root:

```bash
make dev                        # app + Redis in Docker, hot reload, http://localhost:3000
cp packages/rate-limiter/.env.example .env   # optional: compose passes .env to the app
```

| Route                                    | Unauthenticated                  | Authenticated | Algorithm    |
| ---------------------------------------- | -------------------------------- | ------------- | ------------ |
| `GET /api/public` and any other `/api/*` | 100 / hour                       | 200 / hour    | fixed window |
| `GET /api/search?q=`                     | 20 / minute                      | 60 / minute   | sliding log  |
| `POST /api/login`                        | 5 / 15 min                       | 5 / 15 min    | fixed window |
| `GET /api/me`                            | requires bearer token            | 200 / hour    | fixed window |
| `GET /health`, `GET /openapi.json`       | exempt                           |               |              |
| `/admin/overrides`                       | exempt, requires `X-Admin-Token` |               |              |

Demo users: `alice` / `wonderland` (token `alice-token`), `bob` / `builder` (token `bob-token`).
Admin token: `admin-secret`. All configurable, see [`.env.example`](.env.example).

```bash
# Exhaust the anonymous budget quickly (3 requests/minute) and watch the 429
printf 'UNAUTH_LIMIT=3\nUNAUTH_WINDOW_MS=60000\n' > .env && make dev
for i in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code} ' localhost:3000/api/public; done
curl -i localhost:3000/api/public
# HTTP/1.1 429 Too Many Requests
# RateLimit-Limit: 3
# RateLimit-Remaining: 0
# RateLimit-Reset: 57
# RateLimit-Policy: 3;w=60
# Retry-After: 57
# {"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":3,"remaining":0,"retryAfterSeconds":57}
```

Override examples (`ttlSeconds` or an absolute `expiresAt` is required):

```bash
# Launch day: double every limit for six hours
curl -X POST localhost:3000/admin/overrides -H 'X-Admin-Token: admin-secret' -H 'Content-Type: application/json' \
  -d '{"reason":"Product launch","criteria":{},"effect":{"multiplier":2},"ttlSeconds":21600}'

# Support escalation: one user's search limit becomes 1000 for a day
curl -X POST localhost:3000/admin/overrides -H 'X-Admin-Token: admin-secret' -H 'Content-Type: application/json' \
  -d '{"reason":"Ticket #4821","criteria":{"userIds":["alice"],"ruleIds":["search"]},"effect":{"limit":1000},"ttlSeconds":86400}'

# Abuse: block an IP for an hour
curl -X POST localhost:3000/admin/overrides -H 'X-Admin-Token: admin-secret' -H 'Content-Type: application/json' \
  -d '{"reason":"Credential stuffing","criteria":{"ips":["203.0.113.7"]},"effect":{"limit":0},"ttlSeconds":3600}'

curl -H 'X-Admin-Token: admin-secret' localhost:3000/admin/overrides
curl -X DELETE -H 'X-Admin-Token: admin-secret' localhost:3000/admin/overrides/<id>
```

When several overrides match, the most specific wins (most criteria fields); ties go to the newest.

## Using it as a library

```ts
import express from 'express';
import { Redis } from 'ioredis';
import { RateLimiter, RedisStore, RedisOverrideStore, rateLimit } from '@challenge/rate-limiter';

const redis = new Redis(process.env.REDIS_URL);

const limiter = new RateLimiter({
  store: new RedisStore(redis),
  overrides: new RedisOverrideStore(redis), // optional
  algorithm: 'fixed-window',
  limits: {
    unauthenticated: { limit: 100, windowMs: 3_600_000 },
    authenticated: { limit: 200, windowMs: 3_600_000 },
  },
  endpoints: [
    {
      id: 'search',
      path: '/api/search',
      algorithm: 'sliding-log',
      limits: {
        unauthenticated: { limit: 20, windowMs: 60_000 },
        authenticated: { limit: 60, windowMs: 60_000 },
      },
    },
    {
      id: 'login',
      path: '/api/login',
      methods: ['POST'],
      limits: { unauthenticated: { limit: 5, windowMs: 900_000 } },
    },
  ],
  failurePolicy: 'open',
  onStoreError: (error) => console.warn('rate limiter degraded', error),
});

const app = express();
app.use(yourAuthMiddleware); // sets req.user = { id }
app.use(rateLimit({ limiter, skip: (req) => req.path === '/health' }));
```

### `RateLimiter` options

| Option          | Default        | Meaning                                                                          |
| --------------- | -------------- | -------------------------------------------------------------------------------- |
| `store`         | required       | `RateLimitStore`: `RedisStore` or `MemoryStore`                                  |
| `limits`        | required       | `{ unauthenticated, authenticated, ...customTiers }`, each `{ limit, windowMs }` |
| `algorithm`     | `fixed-window` | default algorithm                                                                |
| `endpoints`     | `[]`           | endpoint rules, first match wins                                                 |
| `overrides`     | none           | `OverrideProvider`: `RedisOverrideStore` or `MemoryOverrideStore`                |
| `keyPrefix`     | `rl`           | Redis key prefix (`rl:<algo>:<rule>:<subject>`)                                  |
| `failurePolicy` | `open`         | `open` allows requests when the store fails, `closed` denies them                |
| `onStoreError`  | none           | called with every store / override lookup failure                                |
| `now`           | `Date.now`     | clock, injectable for tests                                                      |

The engine is framework-agnostic: `limiter.check({ identity, path, method })` returns a
`Decision` and can be called for non-HTTP traffic such as WebSocket messages.

### `rateLimit` middleware options

| Option      | Default                | Meaning                                                                          |
| ----------- | ---------------------- | -------------------------------------------------------------------------------- |
| `identify`  | `identifyByUserOrIp()` | derives `{ key, tier }` from the request; `identifyByIp()` keys everything by IP |
| `skip`      | none                   | exempt requests                                                                  |
| `headers`   | `standard`             | `standard` (IETF `RateLimit-*`), `legacy` (`X-RateLimit-*`), `both`, `none`      |
| `onLimited` | JSON 429               | custom 429 response                                                              |
| `message`   | generic                | message in the default 429 body                                                  |

The decision is exposed on `res.locals.rateLimit`.

## Testing

From the repository root:

```bash
make test                     # everything, inside Docker, against the compose Redis
make test-watch               # Vitest watch mode inside the container
make smoke                    # production image + black-box smoke suite
make redis && npm test        # Vitest on the host (REDIS_URL defaults to localhost:6379)
```

| Layer                  | Runs where                                                    | Clock | Proves                                                                                 |
| ---------------------- | ------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| Pure logic             | in process, no I/O                                            | fake  | engine, rules, override precedence, config, header/identity helpers, `MemoryStore`     |
| Store contracts        | real Redis                                                    | fake  | memory and Redis stores behave identically; atomicity under 50 concurrent requests     |
| API suite (`test/app`) | `createApp` on a real port, real Redis, real HTTP via `fetch` | fake  | full behaviour and OpenAPI conformance of every response, outages via a wrapped client |
| Smoke (`test/smoke`)   | black box against `APP_URL`, normally the runtime image       | real  | the deployable artefact end to end                                                     |

Tests fail fast with a hint if Redis is unreachable. Each test uses a unique key prefix, so the
parallel workers share one Redis safely, and leftovers under `test:*` are swept at start-up.

## Project layout

```
openapi.yaml                 the HTTP contract (source of truth)
src/core/                    RateLimiter engine, rule compilation, path matching, types
src/stores/                  MemoryStore, RedisStore + Lua scripts
src/overrides/               matching/precedence, MemoryOverrideStore, RedisOverrideStore
src/express/                 rateLimit() middleware, identity strategies, headers
src/demo/                    createApp, auth, admin API, config, server (composition root)
src/demo/generated/          types generated from openapi.yaml (npm run openapi:types)
test/                        contract, pure-logic, store, API and smoke suites + helpers
vitest.config.ts             main suite (global setup checks Redis)
vitest.smoke.config.ts       smoke suite (needs only APP_URL)
```

## Notes and limitations

- Timestamps come from the application clock and are passed to the Lua scripts; Redis TTLs are
  only garbage collection. Clock skew between instances shifts windows by the skew amount.
- The sliding log stores one entry per allowed request; for very high limits a sliding-window
  counter approximation would be cheaper.
- Override visibility across instances is eventually consistent, bounded by `OVERRIDES_REFRESH_MS`.
- Authentication in the demo is a static token map standing in for real JWT/session middleware.
