# Backend Coding Challenge — Convert Digital

Submission for **Option 1: API Rate Limiter**. The repository is an npm workspace so that
**Option 2 (WebSocket chat server)** can be added later as `packages/chat-server` and reuse the
rate limiting engine for message throttling.

| Package                                                    | What it is                                                                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/rate-limiter`](packages/rate-limiter/README.md) | Redis-backed rate limiting for Express 5 + TypeScript: fixed window and sliding log, per-endpoint and per-tier limits, temporary overrides, and an OpenAPI-first demo API. |

Start with [`docs/DESIGN.md`](docs/DESIGN.md) for the design and the reasoning behind it, and
[`packages/rate-limiter/openapi.yaml`](packages/rate-limiter/openapi.yaml) for the HTTP contract.

## Quick start (Docker)

Requirements: Docker with Compose v2. Node 24 is only needed for the optional host commands.

```bash
npm run dev          # app with hot reload + Redis  →  http://localhost:3000
npm test             # the whole test suite, inside Docker, against the compose Redis
npm run test:smoke   # build the production image, start it, run the black-box smoke suite
npm run prod:down    # stop the production stack started by test:smoke / prod:up
```

Something else on port 3000 or 6379? Set `APP_PORT` / `REDIS_PORT`, e.g. `APP_PORT=3100 npm run dev`.

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

| Command                                   | Purpose                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run dev` / `dev:down`                | App (hot reload) + Redis in Docker                                                        |
| `npm test`                                | Full suite inside the dev image against the compose Redis (what CI runs)                  |
| `npm run test:host`                       | Same suite with Vitest on the host; needs `npm run redis:up`                              |
| `npm run test:smoke`                      | Build the runtime image, start it with Redis, run `test/smoke` against it                 |
| `npm run prod:up` / `prod:down`           | Run the production image locally                                                          |
| `npm run check`                           | `format:check` + `openapi:check` + `typecheck` + `test:host` (CI runs this inside Docker) |
| `npm run openapi:types` / `openapi:check` | Regenerate / verify the TypeScript types generated from `openapi.yaml`                    |
| `npm run redis:up` / `redis:down`         | Only Redis, for host-side work                                                            |
| `npm run build`, `typecheck`, `format`    | The usual                                                                                 |

## Repository layout

```
docs/DESIGN.md                      design & decisions
Dockerfile                          deps → dev | build → runtime (the deployable image)
compose.yaml                        local development: redis, app, test runner
compose.prod.yaml                   production image + redis + smoke runner
.github/workflows/ci.yml            check pipeline in Docker; runtime image smoke test
packages/rate-limiter/              Option 1 (see its README)
```

## How it was built

- **Design first**: the architecture and trade-offs were written down before code
  (`docs/DESIGN.md`), and the HTTP surface was specified in `openapi.yaml` before any route existed.
- **Contract first**: the OpenAPI document drives request validation, security enforcement,
  response validation in tests, generated TypeScript types, and the served `/openapi.json`.
- **Test-driven**: every module was written against a failing test; the git history keeps the
  red/green pairs.
- **Real infrastructure in tests**: every Redis-touching test runs against a real Redis, and the
  API suite serves `createApp()` on a real port and talks to it over real HTTP. Only the clock,
  the id generator and the Redis client wrapper are injected. A black-box smoke suite then runs
  against the production image.
- **Dependency injection from the top**: `createApp({ config, redis, clock, ids, logger })`
  receives everything from the composition root (`server.ts`).

## Dependency versions

All dependencies are on their current major versions except where a peer dependency pins them:

| Package       | Version used | Note                                                                                                    |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| TypeScript    | 5.9          | `openapi-typescript` declares a `^5` peer; TypeScript 7 (native compiler) is otherwise ready to drop in |
| ioredis       | 6.0          | current major                                                                                           |
| `@types/node` | 24           | matches the Node 24 LTS runtime in `.nvmrc` and the Docker base image                                   |
