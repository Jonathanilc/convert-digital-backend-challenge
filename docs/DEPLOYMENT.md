# Deployment: Fly.io Machines

Two apps share one Redis in the `interview-infras` organisation. The first table is the rate
limiter (Option 1); the chat server (Option 2) follows in its own section.

The demo API runs on [Fly.io](https://fly.io) Machines in Sydney, with a managed Redis (Upstash) on
Fly's private network. This is the runbook; the reasoning is in [DESIGN.md §13](DESIGN.md#13-deployment).

| Item     | Value                                                                               |
| -------- | ----------------------------------------------------------------------------------- |
| App      | `convert-digital-rate-limiter` → https://convert-digital-rate-limiter.fly.dev       |
| Region   | `syd`                                                                               |
| Machines | 1 × `shared-cpu-1x` 256 MB (`--ha=false`), stopped when idle, auto-start on request |
| Redis    | `convert-digital-rate-limiter-redis`, Upstash pay-as-you-go, eviction disabled      |
| Config   | [`fly.toml`](../fly.toml); secrets via `fly secrets`                                |
| Image    | built in CI, pushed to `registry.fly.io/convert-digital-rate-limiter:<git sha>`     |

## How a deploy happens

Every push to `main` runs the CI workflow:

1. `check` and `smoke` jobs, exactly as `make check` and `make smoke` locally.
2. `deploy` job (only when the repository variable `FLY_APP` is set): `make deploy` builds the
   `runtime` stage for `linux/amd64`, pushes it to the Fly registry tagged with the git SHA, and
   runs `fly deploy --image` with that tag. Fly replaces Machines one at a time (`rolling`) and
   only moves on once the new Machine answers `GET /ready`.
3. `make smoke-remote` runs the black-box suite against the live URL with the real admin token,
   including a check that the server sees the caller's real IP through Fly's proxy.

What ships is byte-identical to what passed the smoke job. A failed remote smoke fails the
workflow loudly; it does not roll back on its own (see below).

## First-time setup (already done for this app)

```bash
fly auth login
fly apps create convert-digital-rate-limiter --org interview-infras
fly redis create --name convert-digital-rate-limiter-redis --org interview-infras --region syd \
  --no-replicas --disable-eviction --enable-prodpack=false --plan "Pay-as-you-go"
fly secrets set --app convert-digital-rate-limiter \
  REDIS_URL='redis://default:...@fly-convert-digital-rate-limiter-redis.upstash.io' \
  ADMIN_TOKEN="$(openssl rand -hex 24)" \
  DEMO_USERS='alice:wonderland:alice-token,bob:builder:bob-token'

# CI credentials
fly tokens create deploy --app convert-digital-rate-limiter -x 8760h | gh secret set FLY_API_TOKEN
gh secret set ADMIN_TOKEN            # same value as above
gh variable set FLY_APP --body convert-digital-rate-limiter   # opens the deploy gate
```

Notes:

- Fly requires a payment method on the organisation before it creates the Redis add-on or runs
  Machines past the trial.
- `NODE_ENV=production` makes the server refuse to start with the default admin token or without
  an explicit `DEMO_USERS`, so a missing secret fails the deploy at the health check instead of
  running with demo defaults.
- Rotating the admin token: `fly secrets set ADMIN_TOKEN=...` (triggers a redeploy) and
  `gh secret set ADMIN_TOKEN` so the remote smoke keeps working.

## Day to day

```bash
make fly-status                    # machines, health, recent releases
make fly-logs                      # tail JSON logs
make deploy                        # manual deploy of the current commit (needs Docker + fly auth)
make smoke-remote ADMIN_TOKEN=...  # black-box suite against the live app
fly ssh console --app convert-digital-rate-limiter   # shell into a Machine
```

Logs are one JSON object per line (pino). Each request line carries `req.id` (Fly's request id),
`res.statusCode`, `responseTime` and `rateLimit { ruleId, tier, allowed, remaining, override? }`.
`/health` and `/ready` probes are not logged.

## Rollback

Every deploy is an immutable image tagged with the git SHA, so rollback is a redeploy:

```bash
fly releases --app convert-digital-rate-limiter          # find the previous version's image
fly deploy --app convert-digital-rate-limiter --image registry.fly.io/convert-digital-rate-limiter:<previous sha>
```

Rolling strategy and the `/ready` check apply to rollbacks too. Redis data (counters, overrides)
is unaffected by app deploys.

## Scaling and cost

This is a demo, so the deployment is sized for minimum cost:

- One `shared-cpu-1x` 256 MB Machine (`--ha=false` on deploy). Running non-stop it would be
  $2.19/month; with `auto_stop_machines` it stops after a few minutes idle and costs only its
  stopped rootfs, about $0.15 per GB per month, so a few cents. It wakes in about a second.
- Redis pay-as-you-go: $0 base, $0.20 per 100k commands (two or three commands per limited request).
- Fly has no free tier beyond a short trial; billing is pay-as-you-go with no monthly fee.

To demonstrate multiple instances sharing one limit:

```bash
fly scale count 2 --app convert-digital-rate-limiter    # and back to 1 afterwards
fly scale memory 512 --app convert-digital-rate-limiter # per-Machine memory, if ever needed
```

## Platform specifics that matter for a rate limiter

- **Client IP.** Fly terminates TLS and proxies to the Machine. The rightmost `X-Forwarded-For`
  entry on Fly is the app's own public IP, so Express hop counting would key every caller on one
  address. The app reads `Fly-Client-IP` instead (`CLIENT_IP_HEADER` in `fly.toml`), which Fly sets
  and clients cannot forge. The remote smoke suite proves this on every deploy by blocking the
  runner's own egress IP and expecting a 429.
- **Readiness vs fail-open.** `/ready` returns 503 only when the instance cannot serve: Redis down
  _and_ `FAILURE_POLICY=closed`. With the default fail-open policy a Redis outage keeps Machines in
  rotation (requests pass without limits) and shows up in `/health` as `degraded` and in logs as
  `rateLimit.degraded: true`.
- **Multiple Machines, one limit.** Any number of Machines share the Upstash Redis; the Lua
  scripts keep counting atomic across them. The demo runs one Machine for cost; scale to two to
  show it.

## Not yet in place

- Staging environment (would be a second app with the same workflow and a `fly.staging.toml`).
- Alerting: Fly's built-in metrics dashboard covers requests and Machine health; no paging.
- Custom domain: `fly certs add <domain>` when one exists.

## Chat server (Option 2)

| Item    | Value                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| App     | `convert-digital-chat` (org `interview-infras`) → https://convert-digital-chat.fly.dev                                  |
| Docs    | https://convert-digital-chat.fly.dev/docs (HTTP, Swagger UI), `/asyncapi.yaml` (WebSocket contract), `/openapi.json`    |
| Region  | `syd`                                                                                                                   |
| Machine | 1 × `shared-cpu-1x` 256 MB (`--ha=false`), stopped when idle; Fly keeps it running while WebSocket connections are open |
| Storage | Fly volume `chat_data` (1 GB, about $0.15/month) mounted at `/data`, SQLite file `/data/chat.db`                        |
| Redis   | the rate limiter's Upstash database, shared (rate limiting only)                                                        |
| Config  | [`fly.chat.toml`](../fly.chat.toml); secrets `REDIS_URL`, `JWT_SECRET`, `SEED_USERS`                                    |
| Image   | `registry.fly.io/convert-digital-chat:<git sha>`, Dockerfile target `runtime-chat`                                      |

Deploys follow the same path as the rate limiter: CI builds the `runtime-chat` image once, pushes
it by git SHA, rolls it out behind `GET /ready`, then runs the chat smoke suite against the live URL,
which logs in, opens a real WebSocket, joins the default room and exchanges a message. The deploy
job is gated on the `FLY_APP_CHAT` repository variable and uses the `FLY_API_TOKEN_CHAT` secret.

```bash
make deploy-chat                                   # manual deploy of the current commit
make smoke-remote-chat                             # smoke the live chat app
make fly-status FLY_CONFIG=fly.chat.toml           # machines / releases
make fly-logs FLY_CONFIG=fly.chat.toml
fly ssh console --app convert-digital-chat -C "ls -la /data"
```

First-time setup (done):

```bash
fly apps create convert-digital-chat --org interview-infras
fly volumes create chat_data --app convert-digital-chat --region syd --size 1 --yes
fly secrets set --app convert-digital-chat \
  REDIS_URL='redis://default:...@fly-convert-digital-rate-limiter-redis.upstash.io' \
  JWT_SECRET="$(openssl rand -hex 32)" \
  SEED_USERS='admin:<random>:admin,alice:wonderland:user,bob:bob-builder:user'
fly tokens create deploy --app convert-digital-chat -x 8760h | gh secret set FLY_API_TOKEN_CHAT
gh variable set FLY_APP_CHAT --body convert-digital-chat
```

Notes:

- Production refuses the default `JWT_SECRET` (and anything shorter than 32 characters) and requires
  an explicit `SEED_USERS`, so a missing secret fails at the readiness check rather than running with
  demo credentials. The seeded admin password lives in the git-ignored `.env.production.local`.
- One Machine with a volume means one SQLite writer, which is exactly the constraint SQLite wants.
  Scaling out means Postgres plus Redis pub/sub for fan-out (see `docs/CHAT.md` §7), not more
  Machines on this image.
- Rotating the JWT secret logs everyone out: `fly secrets set JWT_SECRET=...` redeploys.
- Backup: `fly volumes snapshots list chat_data`; Fly takes daily snapshots of volumes by default.
