# Backend Coding Challenge — Convert Digital

Submission covering **both options**: the API rate limiter (Option 1) and the WebSocket chat
server (Option 2), which reuses the rate limiting engine for message throttling. One npm
workspace, one Docker build, one CI pipeline.

| Package                                                    | What it is                                                                                                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/rate-limiter`](packages/rate-limiter/README.md) | Option 1. Redis-backed rate limiting for Express 5 + TypeScript: fixed window and sliding log, per-endpoint and per-tier limits, temporary overrides, and an OpenAPI-first demo API.                      |
| [`packages/chat-server`](packages/chat-server/README.md)   | Option 2. WebSocket chat: rooms, JWT accounts, SQLite history with keyset pagination, @mentions, edit/delete, per-user message rate limiting via Option 1, admin API. AsyncAPI 3 + OpenAPI 3.1 contracts. |

Start with [`docs/DESIGN.md`](docs/DESIGN.md) (rate limiter) and [`docs/CHAT.md`](docs/CHAT.md)
(chat server) for the designs and the reasoning behind them. The contracts are
[`packages/rate-limiter/openapi.yaml`](packages/rate-limiter/openapi.yaml),
[`packages/chat-server/openapi.yaml`](packages/chat-server/openapi.yaml) and
[`packages/chat-server/asyncapi.yaml`](packages/chat-server/asyncapi.yaml). Live docs:
https://convert-digital-rate-limiter.fly.dev/docs and https://convert-digital-chat.fly.dev/docs.
The live API renders it as Swagger UI at https://convert-digital-rate-limiter.fly.dev/docs.

## Quick start (Docker)

Requirements: Docker with Compose v2 and `make`. Node 24 is only needed for optional host-side runs.

```bash
make            # list every target
make dev        # rate limiter :3000, chat server :3001, hot reload, Redis
make test       # the whole test suite, inside Docker, against the compose Redis
make smoke      # build the production image, start it, run the black-box smoke suite, tear down
```

Ports taken? `APP_PORT=3100 CHAT_PORT=3101 REDIS_PORT=6380 make dev`.

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

## Commands

`make` owns everything that touches Docker. npm scripts are plain Node tasks that run the same
way on the host and inside the containers (`npm test`, `npm run check`, `npm run build`, ...).

| Target                                        | Purpose                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `make dev` / `up` / `down` / `logs` / `shell` | Development stack: app with hot reload + Redis                                       |
| `make test`                                   | Full suite inside the dev image against the compose Redis                            |
| `make test-watch`                             | Vitest watch mode inside the container                                               |
| `make check`                                  | `format:check` + `openapi:check` + `typecheck` + tests, inside Docker. What CI runs. |
| `make fmt` / `make openapi-types`             | Prettier write / regenerate the types from `openapi.yaml`, inside the container      |
| `make smoke`                                  | Build the runtime image, start it with Redis, run `test/smoke` against it, tear down |
| `make prod-up` / `prod-down` / `prod-logs`    | The production image running locally                                                 |
| `make image IMAGE=tag`                        | Build and tag the runtime image only                                                 |
| `make redis`                                  | Only Redis, for host-side runs (`npm test` then needs no Docker beyond that)         |
| `make clean`                                  | Stop both stacks, remove volumes, delete `dist/` and `coverage/`                     |

## Deployment

The app is deployed to Fly.io Machines by CI on every push to `main`: the runtime image is built
once, pushed to Fly's registry tagged with the git SHA, rolled out behind the `/ready` check, and
then smoke-tested at its public URL. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the
runbook (setup, secrets, rollback, scaling, cost).

| Target                              | Purpose                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `make deploy`                       | Manual deploy of the current commit (Docker + `fly auth login`) |
| `make smoke-remote ADMIN_TOKEN=...` | Black-box suite against the live app                            |
| `make fly-status` / `fly-logs`      | Machines, releases, logs                                        |

## Repository layout

```
docs/DESIGN.md                      rate limiter design & decisions
docs/CHAT.md                        chat server design & storage rationale
docs/DEPLOYMENT.md                  Fly.io runbook
fly.toml                            Fly.io app configuration (no secrets)
Makefile                            local entry points (make = Docker; npm = Node tasks)
Dockerfile                          deps → dev | build → runtime (the deployable image)
compose.yaml                        local development: redis, app, test runner
compose.prod.yaml                   production image + redis + smoke runner
.github/workflows/ci.yml            check + smoke in Docker, then deploy to Fly and smoke the live URL
packages/rate-limiter/              Option 1 (see its README)
packages/chat-server/               Option 2 (see its README)
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
