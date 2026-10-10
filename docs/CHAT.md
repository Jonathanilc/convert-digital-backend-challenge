# Design: WebSocket Chat Server (Option 2)

`packages/chat-server` is a real-time chat with rooms, accounts, history, mentions, edit/delete,
per-user message rate limiting and an admin API. It reuses the rate limiting engine from Option 1.
This document is the design; the two contracts are the source of truth for behaviour:
[`asyncapi.yaml`](../packages/chat-server/asyncapi.yaml) for WebSocket frames and
[`openapi.yaml`](../packages/chat-server/openapi.yaml) for HTTP.

## 1. Architecture

One Node process serves HTTP (Express 5) and WebSockets (`ws`) on the same port.

| Layer    | Responsibility                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`  | Domain with no I/O: `ChatService` (rooms, membership, messages, admin), authorization rules, mention parsing, wire views, typed `ChatError`s |
| `store/` | `ChatRepository` port and its SQLite implementation (Node's built-in `node:sqlite`)                                                          |
| `ws/`    | Upgrade authentication, frame validation against the AsyncAPI schemas, connection registry, fan-out of `ChatService` events to room members  |
| `http/`  | Accounts (JWT), rooms, history, admin, meta; OpenAPI validation and docs                                                                     |
| `demo/`  | `createChatServer(deps)` and the composition root                                                                                            |

`ChatService` emits typed domain events (`room.joined`, `message.created`, `member.kicked`, …).
The WebSocket layer subscribes once and translates events into frames for the sockets that have
joined the room; the HTTP admin endpoints call the same service, so a ban or kick over HTTP reaches
connected clients immediately. Fan-out is in-process, which is correct for one instance; the
multi-instance path is Redis pub/sub per room (see §7).

Dependency injection from the composition root, as in Option 1:
`createChatServer({ config, redis, repository, clock, ids, logger })`. Tests inject a SQLite file in
a temp directory, the real compose Redis, a fake clock and deterministic ULIDs, then connect real
WebSocket clients to a real port.

Why plain `ws` and not Socket.IO: the brief asks for WebSockets; rooms are a map from room id to
sockets; keeping the protocol as plain JSON frames makes it fully describable in AsyncAPI and
usable from any client without a vendor SDK.

## 2. Protocol

Envelope `{ type, id?, payload }`. A client's correlation `id` is echoed in the `ack` or `error`
that answers the command. Full schemas in `asyncapi.yaml`; inbound frames are validated at runtime
and a malformed frame gets `error { code: invalid_frame }` without dropping the connection.

| Client → server            | Server → room (or sender)                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `join { roomId }`          | `ack`; `room.snapshot` (members, last 50 messages) to the joiner; `joined` to the room            |
| `leave { roomId }`         | `ack`; `left` to the room                                                                         |
| `send { roomId, body }`    | `ack { messageId }`; `message` to the room; `mention` to each mentioned user                      |
| `edit { messageId, body }` | `ack`; `message.edited` to the room                                                               |
| `delete { messageId }`     | `ack`; `message.deleted` to the room                                                              |
| —                          | `error { code, message, retryAfterMs? }` to the sender; `left` when kicked or the room is deleted |

Membership is persistent: joining a room once makes you a member, and you receive its events on
every later connection without re-joining. `left` is explicit; a dropped connection does not
remove membership (presence is out of scope).

## 3. Accounts and authorization

- `POST /auth/register` and `POST /auth/login` return an HS256 JWT (`jose`), 12 h by default.
  Passwords are hashed with Node's `scrypt`; no password library needed.
- Browsers cannot set headers on a WebSocket upgrade, so the token is accepted as `?token=` on the
  upgrade URL as well as `Authorization: Bearer`. A missing or invalid token fails the upgrade with
  HTTP 401 before any socket exists.
- Roles: `user`, `admin`. Rooms are `public` (anyone may join) or `private` (members only; the owner
  or an admin adds members). Edit and delete: author or admin. Banned users are disconnected, and
  cannot log in, join or send.
- `/auth/*` is rate limited per IP with the Option 1 middleware (5 attempts per 15 minutes).

## 4. Rate limiting messages

Each `send` is checked with the Option 1 engine: identity `user:<id>`, rule key `ws:send`, sliding
log, default 10 messages per 10 seconds per user. A blocked send answers
`error { code: rate_limited, retryAfterMs }` and nothing is broadcast or stored. The engine's
temporary-override mechanism from Option 1 is available to this limiter too; exposing it through
the chat admin API (throttle one user, lift the limit for an event) is a follow-up.

## 5. Storing chat history, and why

Chat history is append-mostly and read as "the latest N messages in a room, then older". That
access pattern drives every choice below.

```
users(id, username UNIQUE, password_hash, role, banned_at, created_at)
rooms(id, name UNIQUE, visibility, owner_id, created_at)
room_members(room_id, user_id, joined_at, PRIMARY KEY (room_id, user_id))
messages(id ULID PK, room_id, user_id, body, mentions JSON, created_at, edited_at, deleted_at)
  INDEX (room_id, id DESC)
```

- **ULID primary keys.** Time-sortable, so `WHERE room_id = ? AND id < ?cursor ORDER BY id DESC
LIMIT n` is one index walk and the page cursor is just the last id seen. Keyset pagination stays
  O(page) however deep you scroll and is stable while new messages arrive; offset pagination is
  neither.
- **Soft deletes.** `deleted_at` is set and the body cleared. History shows tombstones in place, the
  `message.deleted` event stays replayable, and nothing silently disappears from a thread.
- **Edits in place with `edited_at`.** Clients can mark edited messages; an edit history table
  would be the next step if moderation needed it.
- **Mentions as JSON.** Resolved to user ids at send time and read only with their message, so a
  join table would add cost without a query that needs it.
- **Cascading deletes** from rooms to members and messages, so deleting a room is one statement.
- **History over HTTP, live traffic over the socket.** Paging through history is request/response
  and cacheable; multiplexing it over the socket would complicate the protocol for no gain.

**SQLite for the demo, Postgres for production.** The repository is a port; the SQL above is
portable. For the demo, Node's built-in `node:sqlite` means zero native dependencies in the Alpine
image and a single file on a 1 GB Fly volume costing about $0.15 a month. Switching to Postgres
means a second repository implementation with a connection pool and migrations, and the same
schema. The honest caveat: Node marks `node:sqlite` experimental (the API, not SQLite itself);
`better-sqlite3` is the drop-in alternative if that warning is unwanted.

## 6. Admin interface

HTTP under `/admin`, for JWTs whose user has the `admin` role: list users, ban and unban, list rooms
with member and message counts, delete a room, kick a user from a room. Every action goes through
`ChatService`, which emits the event the WebSocket layer needs to close sockets or notify rooms.

## 7. Scaling notes

One instance fans out in process. For several instances, publish each `ChatEvent` to a Redis
channel per room and have every instance deliver to its own sockets; message order is given by the
ULIDs, so instances need no coordination beyond pub/sub. SQLite would be replaced by Postgres at the
same time, since a shared database is a prerequisite for multiple writers.

## 8. Testing

Same layers as Option 1, all against real infrastructure: contract tests for both documents (the
AsyncAPI parser plus invariants such as "every command has `ack` and `error` replies"), pure unit
tests for the core, repository tests on a real SQLite file, a WebSocket suite with several real
clients on a real port where every received frame is validated against the AsyncAPI schemas, an
HTTP suite validated against OpenAPI, and a smoke suite against the running container that opens a
real socket and exchanges messages.
