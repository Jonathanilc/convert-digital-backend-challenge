# @challenge/chat-server

Real-time chat over WebSockets with rooms, accounts, persistent history, @mentions, edit/delete,
per-user message rate limiting (via `@challenge/rate-limiter`) and an admin API.

- **Contracts first**: [`asyncapi.yaml`](asyncapi.yaml) (AsyncAPI 3) describes every WebSocket
  frame; [`openapi.yaml`](openapi.yaml) describes the HTTP API. Both are validated at runtime and in
  tests, and TypeScript types are generated from them.
- **Rooms**: public rooms anyone can join, private rooms with owner-managed membership.
- **History**: keyset-paginated per room over HTTP; deleted messages appear as tombstones.
- **Mentions**: `@username` resolved server-side; mentioned users get a `mention` frame on every
  socket they have open.
- **Rate limiting**: 10 messages per 10 seconds per user by default, sliding log, shared Redis.
- **Admin**: list/ban/unban users, list/delete rooms, kick members; effects reach connected
  clients immediately.

Design and the storage "whys": [`../../docs/CHAT.md`](../../docs/CHAT.md).

## Run it

From the repository root (Docker):

```bash
make dev        # rate limiter on :3000 and chat server on :3001, hot reload, Redis
```

Then open http://localhost:3001/docs for the HTTP API (Swagger UI) and
http://localhost:3001/asyncapi.yaml for the WebSocket contract.

Seeded accounts: `admin` / `admin-password` (admin), `alice` / `wonderland`, `bob` / `bob-builder`.

```bash
# log in, then connect a socket with the token
TOKEN=$(curl -s localhost:3001/auth/login -H 'content-type: application/json' \
  -d '{"username":"alice","password":"wonderland"}' | jq -r .token)
ROOM=$(curl -s localhost:3001/rooms -H "authorization: Bearer $TOKEN" | jq -r '.rooms[0].id')
npx wscat -c "ws://localhost:3001/ws?token=$TOKEN"
> {"type":"join","id":"1","payload":{"roomId":"<ROOM>"}}
> {"type":"send","id":"2","payload":{"roomId":"<ROOM>","body":"hello @bob"}}
```

## Protocol in one table

| Client → server            | Server → clients                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `join { roomId }`          | `ack`; `room.snapshot` (members + last 50 messages) to the joiner; `joined` to the room |
| `leave { roomId }`         | `ack`; `left` to the room                                                               |
| `send { roomId, body }`    | `ack { messageId }`; `message` to the room; `mention` to mentioned users                |
| `edit { messageId, body }` | `ack`; `message.edited` to the room                                                     |
| `delete { messageId }`     | `ack`; `message.deleted` to the room                                                    |
|                            | `error { code, message, retryAfterMs? }` to the sender; `left` on kick or room deletion |

Error codes: `invalid_frame`, `unauthorized`, `forbidden`, `not_found`, `not_joined`,
`rate_limited`, `banned`, `internal`. A banned user's sockets are closed with code `4403`.

## HTTP API

| Route                                                                               | Purpose                                                   |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `POST /auth/register`, `POST /auth/login`                                           | Accounts; return a JWT. Rate limited per IP (5 / 15 min). |
| `GET /me`                                                                           | The caller                                                |
| `GET /rooms`, `POST /rooms`, `GET /rooms/{id}`, `POST /rooms/{id}/members`          | Rooms and private membership                              |
| `GET /rooms/{id}/messages?before=&limit=`                                           | History, newest first, cursor = last id seen              |
| `GET /admin/users`, `PUT                                                            | DELETE /admin/users/{id}/ban`                             | Users (admin role) |
| `GET /admin/rooms`, `DELETE /admin/rooms/{id}`, `POST /admin/rooms/{id}/kick`       | Rooms (admin role)                                        |
| `GET /health`, `GET /ready`, `GET /docs`, `GET /openapi.json`, `GET /asyncapi.yaml` | Meta                                                      |

## Configuration

| Variable                              | Default                   | Meaning                                                      |
| ------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| `PORT`                                | `3001`                    |                                                              |
| `REDIS_URL`                           | `redis://localhost:6379`  | rate limiting                                                |
| `DATABASE_FILE`                       | `./data/chat.db`          | SQLite file; `/data/chat.db` on a volume in production       |
| `JWT_SECRET`                          | dev value                 | must be set, non-default and ≥ 32 chars in production        |
| `JWT_TTL_SECONDS`                     | `43200`                   |                                                              |
| `SEED_USERS`                          | demo accounts             | `username:password:role,...`; must be explicit in production |
| `DEFAULT_ROOM`                        | `general`                 | created on first start                                       |
| `MESSAGE_LIMIT` / `MESSAGE_WINDOW_MS` | `10` / `10000`            | per-user send limit                                          |
| `LOGIN_LIMIT` / `LOGIN_WINDOW_MS`     | `5` / `900000`            | per-IP auth limit                                            |
| `TRUST_PROXY`, `CLIENT_IP_HEADER`     | `false`, unset            | as in the rate limiter                                       |
| `FAILURE_POLICY`                      | `open`                    | Redis outage: allow sends (`open`) or refuse (`closed`)      |
| `VALIDATE_RESPONSES`                  | `true` outside production | validate HTTP responses against the contract                 |

## Testing

Everything runs against real infrastructure: a real SQLite file, the compose Redis, a real HTTP
port and real WebSocket clients. Every frame a test receives is validated against `asyncapi.yaml`;
every HTTP response against `openapi.yaml`.

```bash
make test                       # both packages, inside Docker
make redis && npm test -w @challenge/chat-server   # on the host
make smoke                      # production images + black-box smoke (opens a real socket)
```

| Suite           | Covers                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `test/contract` | both documents valid; invariants (every command has `ack`/`error`; unique discriminators; 401/403 on protected routes) |
| `test/core`     | mention parsing, authorization rules, `ChatService` end to end on in-memory SQLite                                     |
| `test/store`    | SQLite repository: constraints, cascades, keyset pagination, tombstones                                                |
| `test/ws`       | several real clients: fan-out, mentions, rate limiting with a fake clock, edits, kicks, bans                           |
| `test/http`     | accounts, rooms, history, admin, meta                                                                                  |
| `test/smoke`    | black box against a running instance                                                                                   |

## Layout

```
asyncapi.yaml, openapi.yaml   contracts
src/core/                     ChatService, authorization, mentions, views, errors, types
src/store/                    ChatRepository port + SQLite implementation
src/ws/                       upgrade auth, frame validation, event fan-out
src/http/                     auth (scrypt + JWT), routes, error mapping, docs page
src/demo/                     createChatServer(deps), config loader, composition root
src/generated/                types generated from both contracts
```

## Limitations

- Fan-out is in-process: one instance. Multi-instance needs Redis pub/sub per room and Postgres
  instead of SQLite (see the design doc).
- No presence: a dropped connection does not emit `left`; membership is persistent by design.
- `node:sqlite` is marked experimental by Node; `better-sqlite3` is the drop-in alternative.
- Rate-limit overrides from the engine are not exposed through the chat admin API yet.
