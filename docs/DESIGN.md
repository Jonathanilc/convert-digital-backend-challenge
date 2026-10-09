# Design: API Rate Limiter (Option 1)

This document is the design and specification for `packages/rate-limiter`. The HTTP contract
itself lives in [`packages/rate-limiter/openapi.yaml`](../packages/rate-limiter/openapi.yaml);
this document explains the model behind it and the decisions taken.

## 1. Goals and scope

- Express 5 + TypeScript middleware that limits requests per client over a time window and
  answers `429 Too Many Requests` when the limit is exceeded.
- Redis as the shared store so many app instances enforce one limit.
- Limits configurable per endpoint and per tier (unauthenticated vs authenticated, extensible).
- Bonus: a sliding-log algorithm and temporary overrides for special events or support cases.
- The engine is framework-agnostic so a future WebSocket chat server (Option 2) can reuse it
  for message-spam throttling.

## 2. Repository layout

```
.
├── docs/DESIGN.md                 this document
├── docker-compose.yml             Redis for local runs and integration tests
├── .github/workflows/ci.yml       typecheck, format, unit + component + integration tests
└── packages/
    └── rate-limiter/
        ├── openapi.yaml           the HTTP contract (source of truth)
        ├── src/
        │   ├── core/              RateLimiter engine, rule compilation, path matching, types
        │   ├── stores/            RateLimitStore implementations: memory, Redis (Lua)
        │   ├── overrides/         OverrideStore implementations: memory, Redis (cached hash)
        │   ├── express/           rateLimit() middleware, identity strategies, headers
        │   └── demo/              createApp(deps) + server.ts composition root
        └── test/
            ├── contract/          OpenAPI document tests
            ├── core/ stores/ overrides/ express/   unit tests (fake clock, no I/O)
            ├── app/               component tests: createApp + ioredis-mock, over HTTP
            └── integration/       the same suites against real Redis (REDIS_URL)
```

An npm workspace is used so Option 2 can be added as `packages/chat-server` depending on
`@challenge/rate-limiter`.

## 3. Architecture

### Layers

| Layer       | Responsibility                                                                             | Knows about                |
| ----------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| `core`      | Decide whether a request is allowed: rule matching, tier limits, overrides, decision shape | nothing framework-specific |
| `stores`    | Atomically count a request against a key for a given algorithm                             | Redis / memory             |
| `overrides` | Find the temporary override that applies to a request                                      | Redis / memory             |
| `express`   | Adapt an HTTP request to the core and translate the decision into headers and status codes | Express                    |
| `demo`      | Wire everything together behind the OpenAPI contract                                       | all of the above           |

### Dependency injection

`createApp(deps)` receives every external dependency and constructs nothing with side
effects itself:

```ts
interface AppDependencies {
  config: AppConfig; // plain data, built from env by server.ts
  redis: Redis; // ioredis client: real, or ioredis-mock in tests
  clock?: () => number; // defaults to Date.now
  ids?: () => string; // override id generator, defaults to randomUUID
  logger?: Logger; // defaults to console
}
```

`server.ts` is the only composition root: it reads the environment, creates the Redis client,
calls `createApp`, listens, and handles shutdown. Component tests call `createApp` with an
`ioredis-mock` instance and a fake clock and exercise the whole application over HTTP.

### Request flow

1. `identify(req)` yields an `Identity`: a subject key and a tier.
2. The engine picks the first endpoint rule whose path and method match, else the default rule.
3. It picks the limit for the tier from the rule, falling back to the global tier defaults.
4. It asks the override provider for an active override and applies its effect.
5. It calls `store.consume(key, { limit, windowMs, algorithm })`, which is atomic per key; the store reads the injected clock.
6. The middleware writes `RateLimit-*` headers and calls `next()` or answers `429`.

## 4. Rate limiting model

### Algorithms

|                 | Fixed window                                | Sliding log                                           |
| --------------- | ------------------------------------------- | ----------------------------------------------------- |
| Redis structure | Hash `{count, resetAt}`                     | Sorted set, score = request timestamp (ms)            |
| Memory per key  | Two fields                                  | One member per allowed request                        |
| Burst behaviour | Up to 2x the limit across a window boundary | Exact: never more than `limit` in any trailing window |
| `Retry-After`   | Time until the window resets                | Time until the oldest entry ages out                  |
| Use             | Cheap default                               | Endpoints where precision matters (search, login)     |

Both run as one Lua script so concurrent requests from many Node processes cannot over-admit.
Denied requests are **not** written to the sliding log; a client that keeps retrying while
blocked is not locked out indefinitely.

### Keys

`rl:<algo>:<ruleId>:<subject>`, e.g. `rl:sl:search:user:alice`. The algorithm code is part of
the key because the two algorithms use different Redis data types; an override that switches
algorithm must never hit a `WRONGTYPE` error.

### Identity and tiers

- `identifyByUserOrIp` (default): authenticated requests are keyed by `user:<id>`, anonymous
  by `ip:<addr>`. A user on a changing IP keeps one budget; many users behind one NAT do not
  share one.
- `identifyByIp`: always keyed by IP; authentication only changes the tier. This is the literal
  reading of the brief and is available for callers who want it.
- Authentication is detected from `req.user.id`. IPv4-mapped IPv6 addresses are normalised.
  Proxies are honoured via Express's `trust proxy` setting.
- Tiers `unauthenticated` and `authenticated` are required. Extra tiers (e.g. `premium`) are
  allowed and inherit the authenticated limit when a rule omits them.

### Endpoint rules

```ts
{ id: 'search', path: '/api/search', methods: ['GET'], algorithm: 'sliding-log',
  limits: { unauthenticated: { limit: 20, windowMs: 60_000 }, authenticated: { limit: 60, windowMs: 60_000 } } }
```

Paths use the same `path-to-regexp` v8 syntax as Express 5 (`/users/:id`, `/files/*rest`) or
a RegExp. The first matching rule wins. Invalid patterns fail at start-up.

## 5. Temporary overrides

An override is `{ id, reason, criteria, effect, startsAt?, expiresAt, createdAt }`.

- **Criteria** (`userIds`, `ips`, `tiers`, `ruleIds`, `paths`) are ANDed; an empty object is a
  global override (e.g. a launch-day event).
- **Effect**: `bypass`, `limit`, `multiplier`, `windowMs`, `algorithm`. `limit` applies before
  `multiplier`. `limit: 0` blocks matching requests, which doubles as a temporary ban.
- **Precedence**: the most specific match wins (most criteria fields set); ties go to the newest.
  Effects are not stacked, which keeps the outcome predictable for operators.
- **Expiry** is mandatory. `startsAt` lets an event be configured ahead of time.

### Storage

`RedisOverrideStore` keeps every override in one Redis hash (`rl:overrides`) and holds a local
snapshot refreshed at most every 5 seconds (stale-while-revalidate). The request hot path
therefore costs zero network calls, and a change becomes visible on every instance within one
refresh interval. Writes go to Redis and update the local snapshot immediately. Expired entries
are removed opportunistically on refresh.

## 6. HTTP contract

`openapi.yaml` (OpenAPI 3.1) is the source of truth and is used five ways:

1. **Request validation and security** at runtime through `express-openapi-validator`:
   parameters, bodies, and the `bearerAuth` / `adminToken` security requirements.
2. **Response validation** in test and development (`validateResponses`), off in production.
3. **Generated TypeScript types** (`openapi-typescript`) that handlers are written against;
   CI regenerates and fails on a diff.
4. **Served document** at `GET /openapi.json`.
5. **Test assertions**: document validity, structural invariants (every `/api` operation
   documents `429` and `503`, every `2xx` carries `RateLimit-*` headers), and schema checks on
   the limiter's own `429` / `503` responses.

### Middleware order

1. Auth resolution: maps a bearer token to `req.user`, rejects nothing.
2. Rate limiter. It runs **before** validation so unknown paths and malformed bodies still
   count. A limiter that only guards valid requests is trivial to bypass.
3. OpenAPI validator: request shape, security requirements, responses in test mode.
4. Routes, then one error handler that maps every error to the contract's `Error` schema.

### Headers

Every evaluated response carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
(seconds) and `RateLimit-Policy` (`<limit>;w=<window seconds>`), following
draft-ietf-httpapi-ratelimit-headers. The legacy `X-RateLimit-*` trio is available by option.
A blocked request also gets `Retry-After`.

## 7. Failure modes

- **Store unreachable, `failurePolicy: 'open'` (default)**: the request passes, no `RateLimit-*`
  headers are sent, `onStoreError` fires. Availability over strictness.
- **`failurePolicy: 'closed'`**: `503 Service Unavailable` with `Retry-After: 1`. The limiter
  being down is a server fault, so `429` would be the wrong signal.
- **Override lookup fails**: base limits apply; the API never goes down because of overrides.
- The Redis client is configured to fail within about one second (`maxRetriesPerRequest: 1`,
  `commandTimeout: 1000`) rather than queueing commands while reconnecting.

## 8. Time

The application clock is injected and passed to the Lua scripts as an argument; Redis TTLs are
only garbage collection. This makes every layer deterministic under a fake clock, including the
Redis store when run against `ioredis-mock`. Trade-off: clock skew between app instances shifts
window boundaries by the skew amount. With NTP that is milliseconds, acceptable for rate
limiting. Using the Redis server clock (`TIME`) would remove the skew but makes tests
time-dependent and `ioredis-mock`'s `TIME` is not wall-clock accurate.

## 9. Testing strategy

| Layer          | Backend                               | Clock                   | Proves                                                                          |
| -------------- | ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| Unit           | `MemoryStore`, throwing store         | fake                    | engine logic: tiers, rules, overrides, fail open/closed                         |
| Store contract | memory, ioredis-mock, real Redis      | fake                    | all stores behave identically, including atomicity under 50 concurrent requests |
| Component      | `createApp` + ioredis-mock, Supertest | fake                    | full HTTP behaviour and contract conformance; no sleeps, no Docker              |
| Integration    | real Redis (`REDIS_URL`)              | fake clock, real server | the Lua scripts on a real server                                                |

Integration tests skip when `REDIS_URL` is unset and always run in CI against a Redis service
container. Implementation followed red-green-refactor: each behaviour was written as a failing
test before the code that satisfies it.

## 10. Tooling and version choices

| Package                   | Version | Note                                                                                                                  |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| Node                      | 24 LTS  | `.nvmrc`; `@types/node` tracks the same major                                                                         |
| TypeScript                | 5.9     | TypeScript 7 (native compiler) is `latest`, but `openapi-typescript` declares a `^5` peer; revisit when it supports 7 |
| Express                   | 5.2     | async error propagation built in                                                                                      |
| ioredis                   | 5.11    | ioredis 6 is out, but `ioredis-mock` (the injectable mock) declares a `^5` peer                                       |
| Vitest                    | 5.0     |                                                                                                                       |
| express-openapi-validator | 5.6     | Express 5 support since 5.5                                                                                           |

## 11. Extending to Option 2

A `packages/chat-server` would depend on this package and call
`limiter.check({ identity: { key: 'user:'+userId, tier }, path: 'ws:message', method: 'SEND' })`
per message. The `path`/`method` pair is just a routing key to the engine, so one rule
`{ id: 'chat-message', path: 'ws:message' }` gives per-user message limits with the same stores,
overrides and admin API.

## 12. Known limitations

- The sliding log stores one member per allowed request; at very high limits (thousands per
  window) a sliding **window counter** approximation would be cheaper. Not needed here.
- Override visibility across instances is eventually consistent (bounded by `refreshMs`).
- The demo's authentication is a static token map; a real deployment would plug in JWT/session
  middleware that sets `req.user`.
