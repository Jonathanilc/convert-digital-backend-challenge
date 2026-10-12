# Live verification against the challenge requirements

_Generated 2026-10-12T20:16:16.745Z (13/10/2026, 9:16:16 am NZ) by `scripts/live-verification.mts` at commit `b0214f2`._

| Target | URL | Deployed image |
|---|---|---|
| Option 1, rate limiter | https://convert-digital-rate-limiter.fly.dev | `convert-digital-rate-limiter:b0214f2` |
| Option 2, chat server | https://convert-digital-chat.fly.dev | `convert-digital-chat:b0214f2` |

**Result: 16/16 checks passed.**

## Method

Every check ran against the **deployed** applications over the public internet from one machine. Limits
were shrunk for this machine's IP alone through the temporary-override API, so real 429s, `Retry-After`
values and sliding-window behaviour could be observed within seconds without affecting other visitors.
Budgets are read from the server's own `RateLimit-Remaining` header rather than assumed, because
counters deliberately carry across override changes. All overrides and test rooms were removed at the
end. Tokens and secrets are redacted. Re-run with `make verify-live`.

What this complements: the automated suites (183 + 69 tests, run in Docker on every push and in CI
against real Redis and real sockets) cover behaviours that cannot be exercised safely on a live system,
in particular fail-open / fail-closed under a Redis outage and exactly-`limit` admission under 50
concurrent requests.

Re-run constraints: the chat server allows 5 logins per IP per 15 minutes and this script uses 3, so
run it at most once per 15 minutes; each run also adds about a dozen anonymous requests to this IP's
hourly budget on the rate limiter.

## Summary

| # | Requirement | Scenario | Result | Time |
|---|---|---|---|---|
| 1.0 | Service is up, Redis-backed | health, readiness, contract and docs endpoints | **PASS** | 0.3s |
| 1.1 | Track requests per IP; 429 when the limit is exceeded; IETF RateLimit headers | default rule shrunk to 5/60s for this IP via an override; walk the budget down to zero, then one more request | **PASS** | 0.4s |
| 1.2 | Per-endpoint configuration | /api/search has its own rule and counter; shrunk to 3/60s for this IP and exhausted while /api/public stays available | **PASS** | 0.3s |
| 1.3 | Per-endpoint configuration: login brute-force rule | /api/login rule shrunk to 2/60s for this IP; failed attempts count; the attempt after the budget is 429 | **PASS** | 0.2s |
| 1.4 | Different limits for authenticated (200/h) vs unauthenticated (100/h) users | log in; compare RateLimit-Limit for the same IP with and without a token; then shrink alice to 3/60s (sliding log, so the demonstration starts from a fresh counter) and show her budget is separate from the anonymous one | **PASS** | 0.4s |
| 1.5 | Bonus: sliding log algorithm | search rule set to sliding-log 2/20s for this IP; one slot frees exactly when the oldest request ages out, not at a window boundary | **PASS** | 42.5s |
| 1.6 | Bonus: temporary overrides | create → listed → effective in headers → expires by itself; a blocking override is applied and then deleted explicitly | **PASS** | 10.1s |
| 1.7 | Admin interface is protected | missing and wrong admin token | **PASS** | 0.1s |
| 1.8 | Real client IP behind the platform proxy | every ip-scoped override above matched this machine's egress IP, so anonymous callers are keyed on the true client address (Fly-Client-IP), not the proxy | **PASS** | 0.0s |
| 2.0 | Service is up (HTTP + both contracts) | health, readiness, OpenAPI, AsyncAPI, docs | **PASS** | 0.4s |
| 2.1 | Basic authentication and authorization | upgrade without token is refused; JWT login works; private rooms refuse non-members until the owner adds them | **PASS** | 0.6s |
| 2.2 | Real-time messaging, rooms, broadcast to all connected clients (+ bonus @mentions) | alice creates a public room; both join over real sockets; alice sends "@bob"; both receive the message and bob receives a mention frame | **PASS** | 0.4s |
| 2.3 | Bonus: message editing and deletion | alice edits then deletes; bob receives message.edited and message.deleted; history shows the tombstone | **PASS** | 0.1s |
| 2.4 | Fetch previous messages (persisted history, keyset pagination) | send 3 messages, page through them newest-first with the cursor | **PASS** | 0.2s |
| 2.5 | Bonus: rate limiting for message sending | alice sends quickly until blocked; the error frame carries rate_limited and retryAfterMs; the blocked message is not broadcast | **PASS** | 1.3s |
| 2.6 | Bonus: administrative interface | admin lists users and rooms; a regular user is forbidden; banning bob closes his socket with 4403; unban; kick | **PASS** | 5.6s |

## Evidence

### 1.0 Service is up, Redis-backed

**Scenario.** health, readiness, contract and docs endpoints

**Result: PASS** · started 2026-10-12T20:15:08.435Z · 0.3s

```text
GET /health → 200  body={"status":"ok","checks":{"redis":"up"}}
GET /ready → 200  body={"status":"ready","checks":{"redis":"up"},"failurePolicy":"open"}
GET /openapi.json → 200
GET /docs → 200
```

### 1.1 Track requests per IP; 429 when the limit is exceeded; IETF RateLimit headers

**Scenario.** default rule shrunk to 5/60s for this IP via an override; walk the budget down to zero, then one more request

**Result: PASS** · started 2026-10-12T20:15:08.747Z · 0.4s

```text
POST /admin/overrides → 201  payload={"reason":"live verification 1.1","criteria":{"ips":["122.57.33.23"],"ruleIds":["default"]},"effect":{"limit":5,"windowMs":60000},"ttlSeconds":300}
GET /api/public (anonymous) → 200  ratelimit-limit=5 ratelimit-remaining=4 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public (anonymous) → 200  ratelimit-limit=5 ratelimit-remaining=3 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public (anonymous) → 200  ratelimit-limit=5 ratelimit-remaining=2 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public (anonymous) → 200  ratelimit-limit=5 ratelimit-remaining=1 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public (anonymous) → 200  ratelimit-limit=5 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=5;w=60
GET /api/public (anonymous) → 429  ratelimit-limit=5 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=5;w=60 retry-after=60 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":5,"remaining":0,"retryAfterSeconds":60,"override":"41f00bb2-2f13-4c15-9bd9-7164d02967ba"}
allowed 5 request(s) before the 429 (budget as reported by the server), Retry-After=60s
DELETE /admin/overrides/41f00bb2-2f13-4c15-9bd9-7164d02967ba → 204
GET /api/public → 200  ratelimit-limit=100 ratelimit-remaining=93 ratelimit-reset=60 ratelimit-policy=100;w=3600  (override removed → default limit again)
```

### 1.2 Per-endpoint configuration

**Scenario.** /api/search has its own rule and counter; shrunk to 3/60s for this IP and exhausted while /api/public stays available

**Result: PASS** · started 2026-10-12T20:15:09.174Z · 0.3s

```text
POST /admin/overrides → 201  payload={"reason":"live verification 1.2","criteria":{"ips":["122.57.33.23"],"ruleIds":["search"]},"effect":{"limit":3,"windowMs":60000},"ttlSeconds":300}
GET /api/search?q=live → 200  ratelimit-limit=3 ratelimit-remaining=2 ratelimit-reset=60 ratelimit-policy=3;w=60
GET /api/search?q=live → 200  ratelimit-limit=3 ratelimit-remaining=1 ratelimit-reset=60 ratelimit-policy=3;w=60
GET /api/search?q=live → 200  ratelimit-limit=3 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=3;w=60
GET /api/search?q=live → 429  ratelimit-limit=3 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=3;w=60 retry-after=60 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":3,"remaining":0,"retryAfterSeconds":60,"override":"fb5307bd-a0be-48d3-a889-5619cb4b7376"}
GET /api/public → 200  ratelimit-limit=100 ratelimit-remaining=92 ratelimit-reset=60 ratelimit-policy=100;w=3600  (different rule, different counter)
DELETE /admin/overrides/fb5307bd-a0be-48d3-a889-5619cb4b7376 → 204
```

### 1.3 Per-endpoint configuration: login brute-force rule

**Scenario.** /api/login rule shrunk to 2/60s for this IP; failed attempts count; the attempt after the budget is 429

**Result: PASS** · started 2026-10-12T20:15:09.447Z · 0.2s

```text
POST /admin/overrides → 201  payload={"reason":"live verification 1.3","criteria":{"ips":["122.57.33.23"],"ruleIds":["login"]},"effect":{"limit":2,"windowMs":60000},"ttlSeconds":300}
POST /api/login (wrong password) → 401  ratelimit-limit=2 ratelimit-remaining=1 ratelimit-reset=60 ratelimit-policy=2;w=60 body={"error":"Unauthorized","message":"Invalid username or password"}
POST /api/login (wrong password) → 401  ratelimit-limit=2 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=2;w=60 body={"error":"Unauthorized","message":"Invalid username or password"}
POST /api/login (wrong password) → 429  ratelimit-limit=2 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=2;w=60 retry-after=60 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":2,"remaining":0,"retryAfterSeconds":60,"override":"3f048893-fe00-4fa4-a2a8-ffe85c07fdd7"}
DELETE /admin/overrides/3f048893-fe00-4fa4-a2a8-ffe85c07fdd7 → 204
```

### 1.4 Different limits for authenticated (200/h) vs unauthenticated (100/h) users

**Scenario.** log in; compare RateLimit-Limit for the same IP with and without a token; then shrink alice to 3/60s (sliding log, so the demonstration starts from a fresh counter) and show her budget is separate from the anonymous one

**Result: PASS** · started 2026-10-12T20:15:09.636Z · 0.4s

```text
POST /api/login (alice) → 200  ratelimit-limit=5 ratelimit-remaining=1 ratelimit-reset=60 ratelimit-policy=5;w=900
GET /api/public (anonymous) → 200  ratelimit-limit=100 ratelimit-remaining=91 ratelimit-reset=60 ratelimit-policy=100;w=3600
GET /api/public (Bearer <redacted>) → 200  ratelimit-limit=200 ratelimit-remaining=188 ratelimit-reset=2533 ratelimit-policy=200;w=3600
POST /admin/overrides → 201  payload={"reason":"live verification 1.4","criteria":{"userIds":["alice"],"ruleIds":["default"]},"effect":{"limit":3,"windowMs":60000,"algorithm":"sliding-log"},"ttlSeconds":300}
GET /api/public (Bearer <redacted>) → 200  ratelimit-limit=3 ratelimit-remaining=2 ratelimit-reset=60 ratelimit-policy=3;w=60
GET /api/public (Bearer <redacted>) → 200  ratelimit-limit=3 ratelimit-remaining=1 ratelimit-reset=60 ratelimit-policy=3;w=60
GET /api/public (Bearer <redacted>) → 200  ratelimit-limit=3 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=3;w=60
GET /api/public (Bearer <redacted>) → 429  ratelimit-limit=3 ratelimit-remaining=0 ratelimit-reset=60 ratelimit-policy=3;w=60 retry-after=60 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":3,"remaining":0,"retryAfterSeconds":60,"override":"3b885d0e-5b7c-4072-96f7-1de8374d8a28"}
GET /api/public (anonymous, same IP) → 200  ratelimit-limit=100 ratelimit-remaining=90 ratelimit-reset=59 ratelimit-policy=100;w=3600  (keyed by ip:, not by user:)
DELETE /admin/overrides/3b885d0e-5b7c-4072-96f7-1de8374d8a28 → 204
```

### 1.5 Bonus: sliding log algorithm

**Scenario.** search rule set to sliding-log 2/20s for this IP; one slot frees exactly when the oldest request ages out, not at a window boundary

**Result: PASS** · started 2026-10-12T20:15:10.000Z · 42.5s

```text
waiting 21s so the search requests from 1.2 leave the 20s window (the search rule is sliding-log by default, same key)
POST /admin/overrides → 201  payload={"reason":"live verification 1.5","criteria":{"ips":["122.57.33.23"],"ruleIds":["search"]},"effect":{"limit":2,"windowMs":20000,"algorithm":"sliding-log"},"ttlSeconds":300}
t+0.0s GET /api/search → 200  ratelimit-limit=2 ratelimit-remaining=1 ratelimit-reset=20 ratelimit-policy=2;w=20
t+4.2s GET /api/search → 200  ratelimit-limit=2 ratelimit-remaining=0 ratelimit-reset=16 ratelimit-policy=2;w=20
t+5.2s GET /api/search → 429  ratelimit-limit=2 ratelimit-remaining=0 ratelimit-reset=15 ratelimit-policy=2;w=20 retry-after=15 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":2,"remaining":0,"retryAfterSeconds":15,"override":"7b0169aa-eab5-4d07-b298-ac0e66fa00f5"}
t+21.3s GET /api/search → 200  ratelimit-limit=2 ratelimit-remaining=0 ratelimit-reset=3 ratelimit-policy=2;w=20  (first slot freed)
t+21.4s GET /api/search → 429  ratelimit-limit=2 ratelimit-remaining=0 ratelimit-reset=3 ratelimit-policy=2;w=20 retry-after=3 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":2,"remaining":0,"retryAfterSeconds":3,"override":"7b0169aa-eab5-4d07-b298-ac0e66fa00f5"}  (second request still inside the window → sliding, not reset)
DELETE /admin/overrides/7b0169aa-eab5-4d07-b298-ac0e66fa00f5 → 204
```

### 1.6 Bonus: temporary overrides

**Scenario.** create → listed → effective in headers → expires by itself; a blocking override is applied and then deleted explicitly

**Result: PASS** · started 2026-10-12T20:15:52.519Z · 10.1s

```text
POST /admin/overrides → 201  payload={"reason":"live verification 1.6 (expires)","criteria":{"ips":["122.57.33.23"],"ruleIds":["default"]},"effect":{"limit":7,"windowMs":60000},"ttlSeconds":8}
GET /admin/overrides → 200  ids=["c0123b38-f855-4102-94fc-f57391e47e74"]
GET /api/public (override active) → 429  ratelimit-limit=7 ratelimit-remaining=0 ratelimit-reset=17 ratelimit-policy=7;w=60 retry-after=17 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":7,"remaining":0,"retryAfterSeconds":17,"override":"c0123b38-f855-4102-94fc-f57391e47e74"}
GET /api/public (after ttl) → 200  ratelimit-limit=100 ratelimit-remaining=88 ratelimit-reset=7 ratelimit-policy=100;w=3600  (expired without any call)
POST /admin/overrides → 201  payload={"reason":"live verification 1.6 (block)","criteria":{"ips":["122.57.33.23"]},"effect":{"limit":0},"ttlSeconds":120}
GET /api/public (blocked by override) → 429  ratelimit-limit=0 ratelimit-remaining=0 ratelimit-reset=7 ratelimit-policy=0;w=3600 retry-after=7 body={"error":"Too Many Requests","message":"Too many requests, please try again later.","limit":0,"remaining":0,"retryAfterSeconds":7,"override":"5c836a2a-a46a-4415-9955-df95477efa68"}
DELETE /admin/overrides/5c836a2a-a46a-4415-9955-df95477efa68 → 204
GET /api/public (after delete) → 200  ratelimit-limit=100 ratelimit-remaining=86 ratelimit-reset=7 ratelimit-policy=100;w=3600
```

### 1.7 Admin interface is protected

**Scenario.** missing and wrong admin token

**Result: PASS** · started 2026-10-12T20:16:02.587Z · 0.1s

```text
GET /admin/overrides (no token) → 401 body={"error":"Unauthorized","message":"'X-Admin-Token' header required","details":[{"path":"/admin/overrides","message":"'X-Admin-Token' header required"}]}
GET /admin/overrides (wrong token) → 403 body={"error":"Forbidden","message":"Invalid admin token","details":[{"path":"/admin/overrides","message":"Invalid admin token"}]}
```

### 1.8 Real client IP behind the platform proxy

**Scenario.** every ip-scoped override above matched this machine's egress IP, so anonymous callers are keyed on the true client address (Fly-Client-IP), not the proxy

**Result: PASS** · started 2026-10-12T20:16:02.660Z · 0.0s

```text
egress IP(s) used for the ip-scoped overrides: 122.57.33.23
GET /api/public → 200  ratelimit-limit=100 ratelimit-remaining=85 ratelimit-reset=7 ratelimit-policy=100;w=3600  fly-request-id=01M4RW42RGDEBADB08GP5D903D-syd
```

### 2.0 Service is up (HTTP + both contracts)

**Scenario.** health, readiness, OpenAPI, AsyncAPI, docs

**Result: PASS** · started 2026-10-12T20:16:02.700Z · 0.4s

```text
GET /health → 200  body={"status":"ok","checks":{"redis":"up","database":"up"}}
GET /ready → 200
GET /openapi.json → 200
GET /asyncapi.yaml → 200
GET /docs → 200
```

### 2.1 Basic authentication and authorization

**Scenario.** upgrade without token is refused; JWT login works; private rooms refuse non-members until the owner adds them

**Result: PASS** · started 2026-10-12T20:16:03.069Z · 0.6s

```text
WS upgrade without token → HTTP 401
POST /auth/login (alice) → 200  ratelimit-limit=5 ratelimit-remaining=4 ratelimit-reset=900 ratelimit-policy=5;w=900
POST /auth/login (bob) → 200  ratelimit-limit=5 ratelimit-remaining=3 ratelimit-reset=900 ratelimit-policy=5;w=900
POST /rooms (private, by alice) → 201
bob join private room → {"type":"error","id":"p1","payload":{"code":"forbidden","message":"This room is private"}}
POST /rooms/01M4RW43EW8MATCZG80BA5F28B/members (owner adds bob) → 204
bob join private room after being added → {"type":"ack","id":"p2","payload":{}}
```

### 2.2 Real-time messaging, rooms, broadcast to all connected clients (+ bonus @mentions)

**Scenario.** alice creates a public room; both join over real sockets; alice sends "@bob"; both receive the message and bob receives a mention frame

**Result: PASS** · started 2026-10-12T20:16:03.684Z · 0.4s

```text
POST /rooms → 201
alice joined → room.snapshot members=["alice"]
bob joined → room.snapshot members=["alice","bob"]
alice ack → {"type":"ack","id":"s1","payload":{"messageId":"01M4RW44379S3Y8S3DRTVNYVE4"}}
bob received message → {"id":"01M4RW44379S3Y8S3DRTVNYVE4","roomId":"01M4RW43RPPHA3W44C5S4FMXWN","user":{"id":"01M4J8D12PF997F7FCBFN3JKQ4","username":"alice","role":"user"},"body":"hello from the live verification @bob","mentions":[{"id":"01M4J8D143XS6A5QARZX55R2SE","username":"bob","role":"user"}],"createdAt":"2026-10-12T20:16:04.200Z","editedAt":null,"deletedAt":null}
bob received mention → id=01M4RW44379S3Y8S3DRTVNYVE4 mentions=["bob"]
```

### 2.3 Bonus: message editing and deletion

**Scenario.** alice edits then deletes; bob receives message.edited and message.deleted; history shows the tombstone

**Result: PASS** · started 2026-10-12T20:16:04.064Z · 0.1s

```text
bob received → {"id":"01M4RW44379S3Y8S3DRTVNYVE4","roomId":"01M4RW43RPPHA3W44C5S4FMXWN","body":"edited live","editedAt":"2026-10-12T20:16:04.241Z"}
bob received → {"id":"01M4RW44379S3Y8S3DRTVNYVE4","roomId":"01M4RW43RPPHA3W44C5S4FMXWN"}
GET /rooms/01M4RW43RPPHA3W44C5S4FMXWN/messages?limit=5 → 200  first={"id":"01M4RW44379S3Y8S3DRTVNYVE4","roomId":"01M4RW43RPPHA3W44C5S4FMXWN","user":{"id":"01M4J8D12PF997F7FCBFN3JKQ4","username":"alice","role":"user"},"body":"","mentions":[{"id":"01M4J8D143XS6A5QARZX55R2SE","username":"bob","role":"user"}],"createdAt":"2026-10-12T20:16:04.200Z","editedAt":"2026-10-12T20:16:04.241Z","deletedAt":"2026-10-12T20:16:04.277Z"}
```

### 2.4 Fetch previous messages (persisted history, keyset pagination)

**Scenario.** send 3 messages, page through them newest-first with the cursor

**Result: PASS** · started 2026-10-12T20:16:04.183Z · 0.2s

```text
GET /rooms/{id}/messages?limit=2 → 200  bodies=["history 3","history 2"] nextCursor=01M4RW449A9Q2J4M3DD81J4W2P
GET /rooms/{id}/messages?limit=2&before=… → 200  bodies=["history 1",""]
```

### 2.5 Bonus: rate limiting for message sending

**Scenario.** alice sends quickly until blocked; the error frame carries rate_limited and retryAfterMs; the blocked message is not broadcast

**Result: PASS** · started 2026-10-12T20:16:04.372Z · 1.3s

```text
accepted before block: 6; blocking reply: {"type":"error","id":"r6","payload":{"code":"rate_limited","message":"Too many messages, slow down","retryAfterMs":9427}}
bob received 6 burst messages (equals accepted count: true)
```

### 2.6 Bonus: administrative interface

**Scenario.** admin lists users and rooms; a regular user is forbidden; banning bob closes his socket with 4403; unban; kick

**Result: PASS** · started 2026-10-12T20:16:05.634Z · 5.6s

```text
POST /auth/login (admin) → 200  ratelimit-limit=5 ratelimit-remaining=2 ratelimit-reset=898 ratelimit-policy=5;w=900
GET /admin/users (as alice) → 403 body={"error":"Forbidden","message":"Admin role required"}
GET /admin/users → 200  users=["admin:admin","alice:user","bob:user"]
GET /admin/rooms → 200  test room counts={"room":{"id":"01M4RW43RPPHA3W44C5S4FMXWN","name":"live-room-1791836163684","visibility":"public","ownerId":"01M4J8D12PF997F7FCBFN3JKQ4"},"memberCount":2,"messageCount":10}
PUT /admin/users/01M4J8D143XS6A5QARZX55R2SE/ban → 204
bob's socket closed → {"code":4403,"reason":"banned"}
DELETE /admin/users/01M4J8D143XS6A5QARZX55R2SE/ban → 204
POST /admin/rooms/01M4RW43RPPHA3W44C5S4FMXWN/kick → 204
```

## Not verified live, and why

- **Fail-open / fail-closed when Redis is unreachable.** Would require taking the shared Redis down.
  Covered by the engine, middleware and API suites with an injected failing client.
- **Atomicity across concurrent instances.** The demo runs one Machine. Covered by the store contract
  suite: 50 parallel requests, exactly 10 admitted, on real Redis.
- **Fixed-window boundary burst.** The default rule's 60-minute window is impractical to straddle live;
  the memory and Redis stores share one contract suite that covers it.
