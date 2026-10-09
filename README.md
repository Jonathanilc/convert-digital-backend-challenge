# Backend Coding Challenge — Convert Digital

Submission for **Option 1: API Rate Limiter**. The repository is an npm workspace so that
**Option 2 (WebSocket chat server)** can be added later as `packages/chat-server` and reuse the
rate limiting engine for message throttling.

| Package                                                    | What it is                                                                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/rate-limiter`](packages/rate-limiter/README.md) | Redis-backed rate limiting for Express 5 + TypeScript: fixed window and sliding log, per-endpoint and per-tier limits, temporary overrides, and an OpenAPI-first demo API. |

Start with [`docs/DESIGN.md`](docs/DESIGN.md) for the design and the reasoning behind it, and
[`packages/rate-limiter/openapi.yaml`](packages/rate-limiter/openapi.yaml) for the HTTP contract.

## Quick start

Requirements: Node 24 (`.nvmrc`), npm 11, Docker (only for Redis).

```bash
nvm use
npm ci

# Unit + component tests (no Redis needed: the component suite injects ioredis-mock)
npm test

# Integration tests as well, against a real Redis in Docker
npm run redis:up
npm run test:integration

# Run the demo API on http://localhost:3000 (needs the Redis above)
npm run dev:rate-limiter
```

Try it:

```bash
# Anonymous: 100 requests/hour by default
curl -i http://localhost:3000/api/public

# Authenticated: 200 requests/hour, keyed by user instead of IP
curl -i -H 'Authorization: Bearer alice-token' http://localhost:3000/api/me

# Raise one user's search limit for an hour (temporary override)
curl -X POST http://localhost:3000/admin/overrides \
  -H 'X-Admin-Token: admin-secret' -H 'Content-Type: application/json' \
  -d '{"reason":"support ticket","criteria":{"userIds":["alice"],"ruleIds":["search"]},"effect":{"multiplier":2},"ttlSeconds":3600}'
```

## Scripts

| Command                           | Purpose                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm test`                        | Unit + component tests in every workspace (integration tests skip unless `REDIS_URL` is set) |
| `npm run test:integration`        | Same, with `REDIS_URL` defaulting to the Docker Redis                                        |
| `npm run test:coverage`           | Tests with V8 coverage                                                                       |
| `npm run typecheck`               | `tsc --noEmit` across sources and tests                                                      |
| `npm run build`                   | Emit `dist/` per package                                                                     |
| `npm run openapi:types`           | Regenerate TypeScript types from `openapi.yaml` (CI fails if the checked-in file is stale)   |
| `npm run format` / `format:check` | Prettier                                                                                     |
| `npm run redis:up` / `redis:down` | Redis 7 via Docker Compose                                                                   |

## Repository layout

```
docs/DESIGN.md                      design & decisions
docker-compose.yml                  Redis for local runs and integration tests
.github/workflows/ci.yml            format, generated-types check, typecheck, tests (with Redis), build
packages/rate-limiter/              Option 1 (see its README)
```

## How it was built

- **Design first**: the architecture and trade-offs were written down before code
  (`docs/DESIGN.md`), and the HTTP surface was specified in `openapi.yaml` before any route existed.
- **Contract first**: the OpenAPI document drives request validation, security enforcement,
  response validation in tests, generated TypeScript types, and the served `/openapi.json`.
- **Test-driven**: every module was written against a failing test. The same behavioural
  contract suites run against the in-memory store, `ioredis-mock` and a real Redis.
- **Dependency injection from the top**: `createApp({ config, redis, clock, ids, logger })`
  receives everything from the composition root (`server.ts`), so the whole application is
  exercised over HTTP in tests by injecting a mock Redis server and a fake clock.

## Dependency versions

All dependencies are on their current major versions except where a peer dependency pins them:

| Package       | Version used | Note                                                                                                    |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| TypeScript    | 5.9          | `openapi-typescript` declares a `^5` peer; TypeScript 7 (native compiler) is otherwise ready to drop in |
| ioredis       | 5.11         | `ioredis-mock`, the injectable mock server, declares a `^5` peer                                        |
| `@types/node` | 24           | matches the Node 24 LTS runtime in `.nvmrc`                                                             |
