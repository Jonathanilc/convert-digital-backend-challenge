# Live verification against the challenge requirements

_Generated 2026-10-12T19:59:27.116Z (13/10/2026, 8:59:27 am NZ) by `scripts/live-verification.ts` at commit `216f192`._

| Target | URL | Deployed image |
|---|---|---|
| Option 1, rate limiter | https://convert-digital-rate-limiter.fly.dev | `convert-digital-rate-limiter:1a0d2ef` |
| Option 2, chat server | https://convert-digital-chat.fly.dev | `convert-digital-chat:1a0d2ef` |

**Result: 13/16 checks passed.**

## Method

Every check below ran against the **deployed** applications over the public internet, from one machine
(egress IP redacted from this report only where it appears in secrets; it is the IP every ip-scoped
override targets). Limits were shrunk for this machine alone through the temporary-override API so
real 429s, `Retry-After` values and sliding-window behaviour could be observed within seconds without
affecting other visitors. All overrides and test rooms were removed at the end; the appendix lists the
cleanup calls. Tokens and secrets are redacted. The script is idempotent and can be re-run with
`make verify-live`.

What this complements: the automated suites (183 + 69 tests, run in Docker on every push and in CI
against real Redis and real sockets) cover the behaviours that cannot be exercised safely on a live
system, in particular fail-open / fail-closed under a Redis outage and exactly-`limit` admission under
50 concurrent requests.

## Summary

| # | Requirement | Scenario | Result | Time |
|---|---|---|---|---|
| 1.0 | Service is up, Redis-backed | health, readiness, contract and docs endpoints | **PASS** | 0.3s |
| 1.1 | Track requests per IP; 429 when the limit is exceeded; IETF RateLimit headers | default rule shrunk to 5/60s for this IP via an override, then 6 anonymous requests | **PASS** | 0.4s |
| 1.2 | Per-endpoint configuration | /api/search has its own rule (independent budget); shrunk to 3/60s for this IP, exhausted, while /api/public stays available | **PASS** | 0.3s |
| 1.3 | Per-endpoint configuration: login brute-force rule | /api/login rule shrunk to 2/60s for this IP; failed attempts count; third attempt is 429 | **PASS** | 0.2s |
| 1.4 | Different limits for authenticated (200/h) vs unauthenticated (100/h) users | login, compare RateLimit-Limit; then shrink alice to 3/60s and show her budget is separate from the anonymous one | **FAIL** | 0.2s |
| 1.5 | Bonus: sliding log algorithm | search rule switched to sliding-log 2/20s for this IP; observe that one slot frees exactly when the oldest request ages out, not at a window boundary | **FAIL** | 0.1s |
| 1.6 | Bonus: temporary overrides | create → visible in list → effective in headers → expires by itself → delete another one explicitly | **PASS** | 10.0s |
| 1.7 | Admin interface is protected | missing and wrong admin token | **PASS** | 0.1s |
| 1.8 | Real client IP behind the platform proxy | the block override in 1.6 matched this machine's egress IP, so the server keys anonymous callers on the true client address (Fly-Client-IP), not the proxy | **PASS** | 0.0s |
| 2.0 | Service is up (HTTP + both contracts) | health, readiness, OpenAPI, AsyncAPI, docs | **PASS** | 0.3s |
| 2.1 | Basic authentication and authorization | upgrade without token is refused; JWT login works; private rooms refuse non-members until the owner adds them | **PASS** | 0.6s |
| 2.2 | Real-time messaging, rooms, broadcast to all connected clients | alice creates a public room; both join over real sockets; alice sends; both receive the same message | **PASS** | 0.4s |
| 2.3 | Bonus: message editing and deletion | alice edits then deletes; bob receives message.edited and message.deleted; history shows the tombstone | **PASS** | 0.1s |
| 2.4 | Fetch previous messages (persisted history, keyset pagination) | send 3 messages, page through them newest-first with the cursor | **PASS** | 0.2s |
| 2.5 | Bonus: rate limiting for message sending | alice sends quickly until blocked; error frame carries rate_limited and retryAfterMs; nothing extra is broadcast | **PASS** | 1.3s |
| 2.6 | Bonus: administrative interface | admin lists users and rooms, bans bob (his socket closes with 4403), unbans, kicks | **FAIL** | 0.0s |

## Evidence

### 1.0 Service is up, Redis-backed

**Scenario.** health, readiness, contract and docs endpoints

**Result: PASS** · started 2026-10-12T19:58:57.193Z · 0.3s

```text
GET /health → 200  body={"status":"ok","checks":{"redis":"up"}}
GET /ready → 200  body={"status":"ready","checks":{"redis":"up"},"failurePolicy":"open"}
GET /openapi.json → 200
GET /docs → 200
```

### 1.1 Track requests per IP; 429 when the limit is exceeded; IETF RateLimit headers

**Scenario.** default rule shrunk to 5/60s for this IP via an override, then 6 anonymous requests

**Result: PASS** · started 2026-10-12T19:58:57.462Z · 0.4s

```text
POST /admin/overrides → 201  payload={"reason":"live verification 1.1","criteria":{"ips":["122.57.33.23"],"ruleIds":["default"]},"effect":{"limit":5,"windowMs":60000},"ttlSeconds":300}
GET /api/public → 200  ratelimit-limit=5 ratelimit-remaining=4 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public → 200  ratelimit-limit=5 ratelimit-remaining=3 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public → 200  ratelimit-limit=5 ratelimit-remaining=2 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public → 200  ratelimit-limit=5 ratelimit-remaining=1 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public → 200  ratelimit-limit=5 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public → 429  ratelimit-limit=5 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=5;w=60 retry-after=60 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":5,"remaining":0,"retryAfterSeconds":60,"override":"9dcb975a-3455-408d-9657-e10895bfa010"}
sequence: 200 200 200 200 200 429
DELETE /admin/overrides/9dcb975a-3455-408d-9657-e10895bfa010 → 204
GET /api/public → 200  ratelimit-limit=100 ratelimit-remaining=93 ratelimit-reset=60 ratelimit-policy=100;w=3600  (override removed → default limit again)
```

### 1.2 Per-endpoint configuration

**Scenario.** /api/search has its own rule (independent budget); shrunk to 3/60s for this IP, exhausted, while /api/public stays available

**Result: PASS** · started 2026-10-12T19:58:57.893Z · 0.3s

```text
POST /admin/overrides → 201  payload={"reason":"live verification 1.2","criteria":{"ips":["122.57.33.23"],"ruleIds":["search"]},"effect":{"limit":3,"windowMs":60000},"ttlSeconds":300}
GET /api/search?q=live → 200  ratelimit-limit=3 ratelimit-remaining=2 ratelimit-reset=60 ratelimit-policy=3;w=60
GET /api/search?q=live → 200  ratelimit-limit=3 ratelimit-remaining=1 ratelimit-reset=60 ratelimit-policy=3;w=60
GET /api/search?q=live → 200  ratelimit-limit=3 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=3;w=60
GET /api/search?q=live → 429  ratelimit-limit=3 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=3;w=60 retry-after=60 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":3,"remaining":0,"retryAfterSeconds":60,"override":"d121ddd4-dd43-4342-b3db-63ebc9828858"}
GET /api/public → 200  ratelimit-limit=100 ratelimit-remaining=92 ratelimit-reset=60 ratelimit-policy=100;w=3600  (different rule, different counter)
DELETE /admin/overrides/d121ddd4-dd43-4342-b3db-63ebc9828858 → 204
```

### 1.3 Per-endpoint configuration: login brute-force rule

**Scenario.** /api/login rule shrunk to 2/60s for this IP; failed attempts count; third attempt is 429

**Result: PASS** · started 2026-10-12T19:58:58.177Z · 0.2s

```text
POST /admin/overrides → 201  payload={"reason":"live verification 1.3","criteria":{"ips":["122.57.33.23"],"ruleIds":["login"]},"effect":{"limit":2,"windowMs":60000},"ttlSeconds":300}
POST /api/login (wrong password) → 401  ratelimit-limit=2 ratelimit-remaining=1 ratelimit-reset=60 ratelimit-policy=2;w=60 body={"error":"Unauthorized","message":"Invalid username or password"}
POST /api/login (wrong password) → 401  ratelimit-limit=2 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=2;w=60 body={"error":"Unauthorized","message":"Invalid username or password"}
POST /api/login (wrong password) → 429  ratelimit-limit=2 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=2;w=60 retry-after=60 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":2,"remaining":0,"retryAfterSeconds":60,"override":"8314e75d-8212-4e69-b8f5-c73b51bee7df"}
DELETE /admin/overrides/8314e75d-8212-4e69-b8f5-c73b51bee7df → 204
```

### 1.4 Different limits for authenticated (200/h) vs unauthenticated (100/h) users

**Scenario.** login, compare RateLimit-Limit; then shrink alice to 3/60s and show her budget is separate from the anonymous one

**Result: FAIL**  
_expectation failed: alice request 1 passes_ · started 2026-10-12T19:58:58.377Z · 0.2s

```text
POST /api/login (alice) → 200  ratelimit-limit=5 ratelimit-remaining=1 ratelimit-reset=60 ratelimit-policy=5;w=900
GET /api/public (anonymous) → 200  ratelimit-limit=100 ratelimit-remaining=91 ratelimit-reset=60 ratelimit-policy=100;w=3600
GET /api/public (Bearer <redacted>) → 200  ratelimit-limit=200 ratelimit-remaining=195 ratelimit-reset=3504 ratelimit-policy=200;w=3600
POST /admin/overrides → 201  payload={"reason":"live verification 1.4","criteria":{"userIds":["alice"],"ruleIds":["default"]},"effect":{"limit":3,"windowMs":60000},"ttlSeconds":300}
GET /api/public (Bearer <redacted>) → 429  ratelimit-limit=3 ratelimit-remaining=0 ratelimit-reset=3504 ratelimit-policy=3;w=60 retry-after=3504 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":3,"remaining":0,"retryAfterSeconds":3504,"override":"25ec1983-8ce9-4026-ab9d-552361cb9b3f"}
DELETE /admin/overrides/25ec1983-8ce9-4026-ab9d-552361cb9b3f → 204
```

### 1.5 Bonus: sliding log algorithm

**Scenario.** search rule switched to sliding-log 2/20s for this IP; observe that one slot frees exactly when the oldest request ages out, not at a window boundary

**Result: FAIL**  
_expectation failed: first allowed_ · started 2026-10-12T19:58:58.611Z · 0.1s

```text
POST /admin/overrides → 201  payload={"reason":"live verification 1.5","criteria":{"ips":["122.57.33.23"],"ruleIds":["search"]},"effect":{"limit":2,"windowMs":20000,"algorithm":"sliding-log"},"ttlSeconds":300}
t+0.0s GET /api/search → 429  ratelimit-limit=2 ratelimit-remaining=0 ratelimit-reset=20 ratelimit-policy=2;w=20 retry-after=20 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":2,"remaining":0,"retryAfterSeconds":20,"override":"c3857f86-6478-4e4b-a094-025bb82f8068"}
DELETE /admin/overrides/c3857f86-6478-4e4b-a094-025bb82f8068 → 204
```

### 1.6 Bonus: temporary overrides

**Scenario.** create → visible in list → effective in headers → expires by itself → delete another one explicitly

**Result: PASS** · started 2026-10-12T19:58:58.731Z · 10.0s

```text
POST /admin/overrides → 201  payload={"reason":"live verification 1.6 (expires)","criteria":{"ips":["122.57.33.23"],"ruleIds":["default"]},"effect":{"limit":7,"windowMs":60000},"ttlSeconds":8}
GET /admin/overrides → 200  ids=["3730acf4-6896-4642-87b9-837274d090ac"]
GET /api/public (override active) → 429  ratelimit-limit=7 ratelimit-remaining=0 ratelimit-reset=59 ratelimit-policy=7;w=60 retry-after=59 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":7,"remaining":0,"retryAfterSeconds":59,"override":"3730acf4-6896-4642-87b9-837274d090ac"}
GET /api/public (after ttl) → 200  ratelimit-limit=100 ratelimit-remaining=89 ratelimit-reset=50 ratelimit-policy=100;w=3600  (expired without any call)
POST /admin/overrides → 201  payload={"reason":"live verification 1.6 (block)","criteria":{"ips":["122.57.33.23"]},"effect":{"limit":0},"ttlSeconds":120}
GET /api/public (blocked by override) → 429  ratelimit-limit=0 ratelimit-remaining=0 ratelimit-reset=49 ratelimit-policy=0;w=3600 retry-after=49 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":0,"remaining":0,"retryAfterSeconds":49,"override":"11441c00-35e3-4663-8df2-d208e9c841bb"}
DELETE /admin/overrides/11441c00-35e3-4663-8df2-d208e9c841bb → 204
GET /api/public (after delete) → 200  ratelimit-limit=100 ratelimit-remaining=87 ratelimit-reset=49 ratelimit-policy=100;w=3600
```

### 1.7 Admin interface is protected

**Scenario.** missing and wrong admin token

**Result: PASS** · started 2026-10-12T19:59:08.720Z · 0.1s

```text
GET /admin/overrides (no token) → 401 body={"error":"Unauthorized","message":"'X-Admin-Token' header required","details":[{"path":"/admin/overrides","message":"'X-Admin-Token' header required"}]}
GET /admin/overrides (wrong token) → 403 body={"error":"Forbidden","message":"Invalid admin token","details":[{"path":"/admin/overrides","message":"Invalid admin token"}]}
```

### 1.8 Real client IP behind the platform proxy

**Scenario.** the block override in 1.6 matched this machine's egress IP, so the server keys anonymous callers on the true client address (Fly-Client-IP), not the proxy

**Result: PASS** · started 2026-10-12T19:59:08.794Z · 0.0s

```text
egress IP(s) used for every ip-scoped override above: 122.57.33.23
GET /api/public → 200  ratelimit-limit=100 ratelimit-remaining=86 ratelimit-reset=49 ratelimit-policy=100;w=3600  fly-request-id=01M4RV54KB6DDTHDJMFG7X6W6R-syd
```

### 2.0 Service is up (HTTP + both contracts)

**Scenario.** health, readiness, OpenAPI, AsyncAPI, docs

**Result: PASS** · started 2026-10-12T19:59:08.830Z · 0.3s

```text
GET /health → 200  body={"status":"ok","checks":{"redis":"up","database":"up"}}
GET /ready → 200
GET /openapi.json → 200
GET /asyncapi.yaml → 200
GET /docs → 200
```

### 2.1 Basic authentication and authorization

**Scenario.** upgrade without token is refused; JWT login works; private rooms refuse non-members until the owner adds them

**Result: PASS** · started 2026-10-12T19:59:09.178Z · 0.6s

```text
WS upgrade without token → HTTP 401
POST /auth/login (alice) → 200  ratelimit-limit=5 ratelimit-remaining=1 ratelimit-reset=809 ratelimit-policy=5;w=900
POST /auth/login (bob) → 200  ratelimit-limit=5 ratelimit-remaining=0 ratelimit-reset=809 ratelimit-policy=5;w=900
POST /rooms (private, by alice) → 201
bob join private room → {"type":"error","id":"p1","payload":{"code":"forbidden","message":"This room is private"}}
POST /rooms/01M4RV5587VTNVBY73JQADQ08W/members (owner adds bob) → 204
bob join private room after being added → {"type":"ack","id":"p2","payload":{}}
```

### 2.2 Real-time messaging, rooms, broadcast to all connected clients

**Scenario.** alice creates a public room; both join over real sockets; alice sends; both receive the same message

**Result: PASS** · started 2026-10-12T19:59:09.737Z · 0.4s

```text
POST /rooms → 201
alice joined → room.snapshot members=["alice"]
bob joined → room.snapshot members=["alice","bob"]
alice ack → {"type":"ack","id":"s1","payload":{"messageId":"01M4RV55V44VB75JDRK4N69M7G"}}
bob received message → {"id":"01M4RV55V44VB75JDRK4N69M7G","roomId":"01M4RV55H13SQCJ0NSG94MGHZA","user":{"id":"01M4J8D12PF997F7FCBFN3JKQ4","username":"alice","role":"user"},"body":"hello from the live verification @bob","mentions":[{"id":"01M4J8D143XS6A5QARZX55R2SE","username":"bob","role":"user"}],"createdAt":"2026-10-12T19:59:10.180Z","editedAt":null,"deletedAt":null}
bob received mention → id=01M4RV55V44VB75JDRK4N69M7G mentions=["bob"]
```

### 2.3 Bonus: message editing and deletion

**Scenario.** alice edits then deletes; bob receives message.edited and message.deleted; history shows the tombstone

**Result: PASS** · started 2026-10-12T19:59:10.098Z · 0.1s

```text
bob received → {"id":"01M4RV55V44VB75JDRK4N69M7G","roomId":"01M4RV55H13SQCJ0NSG94MGHZA","body":"edited live","editedAt":"2026-10-12T19:59:10.216Z"}
bob received → {"id":"01M4RV55V44VB75JDRK4N69M7G","roomId":"01M4RV55H13SQCJ0NSG94MGHZA"}
GET /rooms/01M4RV55H13SQCJ0NSG94MGHZA/messages?limit=5 → 200  first={"id":"01M4RV55V44VB75JDRK4N69M7G","roomId":"01M4RV55H13SQCJ0NSG94MGHZA","user":{"id":"01M4J8D12PF997F7FCBFN3JKQ4","username":"alice","role":"user"},"body":"","mentions":[{"id":"01M4J8D143XS6A5QARZX55R2SE","username":"bob","role":"user"}],"createdAt":"2026-10-12T19:59:10.180Z","editedAt":"2026-10-12T19:59:10.216Z","deletedAt":"2026-10-12T19:59:10.250Z"}
```

### 2.4 Fetch previous messages (persisted history, keyset pagination)

**Scenario.** send 3 messages, page through them newest-first with the cursor

**Result: PASS** · started 2026-10-12T19:59:10.204Z · 0.2s

```text
GET /rooms/{id}/messages?limit=2 → 200  bodies=["history 3","history 2"] nextCursor=01M4RV560N9EG7NV39CAMJT64W
GET /rooms/{id}/messages?limit=2&before=… → 200  bodies=["history 1",""]
```

### 2.5 Bonus: rate limiting for message sending

**Scenario.** alice sends quickly until blocked; error frame carries rate_limited and retryAfterMs; nothing extra is broadcast

**Result: PASS** · started 2026-10-12T19:59:10.382Z · 1.3s

```text
accepted before block: 6; blocking reply: {"type":"error","id":"r6","payload":{"code":"rate_limited","message":"Too many messages, slow down","retryAfterMs":9461}}
bob received 6 burst messages (equals accepted count: true)
```

### 2.6 Bonus: administrative interface

**Scenario.** admin lists users and rooms, bans bob (his socket closes with 4403), unbans, kicks

**Result: FAIL**  
_expectation failed: admin logs in_ · started 2026-10-12T19:59:11.637Z · 0.0s

```text
POST /auth/login (admin) → 429  ratelimit-limit=5 ratelimit-remaining=0 ratelimit-reset=807 ratelimit-policy=5;w=900 retry-after=807 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":5,"remaining":0,"retryAfterSeconds":807}
```

## Not verified live, and why

- **Fail-open / fail-closed when Redis is unreachable.** Would require taking the shared Redis down.
  Covered by the engine, middleware and API suites with an injected failing client.
- **Atomicity across concurrent instances.** The demo runs one Machine. Covered by the store contract
  suite: 50 parallel requests, exactly 10 admitted, on real Redis.
- **Fixed-window boundary burst.** The default rule's 60-minute window is impractical to straddle live;
  the memory and Redis stores share one contract suite that covers it.
