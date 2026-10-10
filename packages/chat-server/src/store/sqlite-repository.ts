import { DatabaseSync } from 'node:sqlite';
import {
  UniqueConstraintError,
  type MessageRecord,
  type Room,
  type UserRecord,
} from '../core/types.js';
import type {
  ChatRepository,
  CreateRoomInput,
  CreateUserInput,
  ListMessagesOptions,
  RoomWithCounts,
} from './repository.js';

const SCHEMA_VERSION = 1;

/**
 * Schema notes (the "why" behind the shape):
 * - ids are ULIDs: time-sortable, so (room_id, id DESC) is the only index history needs and a
 *   page cursor is simply the last id seen (keyset pagination; stable under concurrent inserts).
 * - messages are soft-deleted (body cleared, deleted_at set) so history can render tombstones
 *   and `message.deleted` events stay replayable.
 * - mentions are resolved to user ids at send time and stored as JSON; they are read with the
 *   message and never queried on their own, so a join table would add cost without benefit.
 * - foreign keys cascade from rooms to members and messages, so deleting a room is one statement.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  banned_at     INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  mentions   TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_room_id_id ON messages (room_id, id DESC);
`;

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'user' | 'admin';
  banned_at: number | null;
  created_at: number;
}
interface RoomRow {
  id: string;
  name: string;
  visibility: 'public' | 'private';
  owner_id: string;
  created_at: number;
}
interface MessageRow {
  id: string;
  room_id: string;
  user_id: string;
  body: string;
  mentions: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  username: r.username,
  role: r.role,
  passwordHash: r.password_hash,
  bannedAt: r.banned_at,
  createdAt: r.created_at,
});
const toRoom = (r: RoomRow): Room => ({
  id: r.id,
  name: r.name,
  visibility: r.visibility,
  ownerId: r.owner_id,
  createdAt: r.created_at,
});
const toMessage = (r: MessageRow): MessageRecord => ({
  id: r.id,
  roomId: r.room_id,
  userId: r.user_id,
  body: r.body,
  mentions: JSON.parse(r.mentions) as string[],
  createdAt: r.created_at,
  editedAt: r.edited_at,
  deletedAt: r.deleted_at,
});

/** Maps SQLite's "UNIQUE constraint failed: table.column" onto a typed error. */
function translate(error: unknown): never {
  const message = (error as Error).message ?? '';
  const match = /UNIQUE constraint failed: \w+\.(\w+)/.exec(message);
  if (match) throw new UniqueConstraintError(match[1] as string);
  throw error;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/**
 * SQLite implementation on Node's built-in driver. All calls are synchronous underneath (SQLite
 * is in-process), exposed through the async port so a networked database can replace it.
 */
export class SqliteChatRepository implements ChatRepository {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
  }

  async migrate(): Promise<void> {
    if (this.schemaVersion() >= SCHEMA_VERSION) return;
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ---- users ----------------------------------------------------------------------------

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    try {
      this.db
        .prepare(
          'INSERT INTO users (id, username, password_hash, role, banned_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
        )
        .run(input.id, input.username, input.passwordHash, input.role, input.createdAt);
    } catch (error) {
      translate(error);
    }
    return (await this.findUserById(input.id)) as UserRecord;
  }

  async findUserById(id: string): Promise<UserRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as
      UserRow | undefined;
    return row && toUser(row);
  }

  async findUserByUsername(username: string): Promise<UserRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as unknown as UserRow | undefined;
    return row && toUser(row);
  }

  async findUsersByIds(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM users WHERE id IN (${placeholders(ids.length)}) ORDER BY created_at, id`,
      )
      .all(...ids) as unknown as UserRow[];
    return rows.map(toUser);
  }

  async findUsersByUsernames(usernames: string[]): Promise<UserRecord[]> {
    if (usernames.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM users WHERE username IN (${placeholders(usernames.length)}) ORDER BY created_at, id`,
      )
      .all(...usernames) as unknown as UserRow[];
    return rows.map(toUser);
  }

  async listUsers(): Promise<UserRecord[]> {
    return (
      this.db.prepare('SELECT * FROM users ORDER BY created_at, id').all() as unknown as UserRow[]
    ).map(toUser);
  }

  async setBanned(userId: string, bannedAt: number | null): Promise<boolean> {
    return (
      this.db.prepare('UPDATE users SET banned_at = ? WHERE id = ?').run(bannedAt, userId).changes >
      0
    );
  }

  // ---- rooms ----------------------------------------------------------------------------

  async createRoom(input: CreateRoomInput): Promise<Room> {
    try {
      this.db
        .prepare(
          'INSERT INTO rooms (id, name, visibility, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(input.id, input.name, input.visibility, input.ownerId, input.createdAt);
    } catch (error) {
      translate(error);
    }
    return (await this.findRoomById(input.id)) as Room;
  }

  async findRoomById(id: string): Promise<Room | undefined> {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as unknown as
      RoomRow | undefined;
    return row && toRoom(row);
  }

  async findRoomByName(name: string): Promise<Room | undefined> {
    const row = this.db.prepare('SELECT * FROM rooms WHERE name = ?').get(name) as unknown as
      RoomRow | undefined;
    return row && toRoom(row);
  }

  async listRooms(): Promise<Room[]> {
    return (
      this.db.prepare('SELECT * FROM rooms ORDER BY created_at, id').all() as unknown as RoomRow[]
    ).map(toRoom);
  }

  async listRoomsVisibleTo(userId: string): Promise<Room[]> {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM rooms r
         WHERE r.visibility = 'public'
            OR EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.user_id = ?)
         ORDER BY r.created_at, r.id`,
      )
      .all(userId) as unknown as RoomRow[];
    return rows.map(toRoom);
  }

  async listRoomsWithCounts(): Promise<RoomWithCounts[]> {
    const rows = this.db
      .prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
                (SELECT COUNT(*) FROM messages x WHERE x.room_id = r.id) AS message_count
         FROM rooms r ORDER BY r.created_at, r.id`,
      )
      .all() as unknown as Array<RoomRow & { member_count: number; message_count: number }>;
    return rows.map((r) => ({
      room: toRoom(r),
      memberCount: r.member_count,
      messageCount: r.message_count,
    }));
  }

  async deleteRoom(id: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id).changes > 0;
  }

  // ---- membership -----------------------------------------------------------------------

  async addMember(roomId: string, userId: string, joinedAt: number): Promise<void> {
    this.db
      .prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(roomId, userId, joinedAt);
  }

  async removeMember(roomId: string, userId: string): Promise<boolean> {
    return (
      this.db
        .prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?')
        .run(roomId, userId).changes > 0
    );
  }

  async isMember(roomId: string, userId: string): Promise<boolean> {
    return (
      this.db
        .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
        .get(roomId, userId) !== undefined
    );
  }

  async listMembers(roomId: string): Promise<UserRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT u.* FROM room_members m JOIN users u ON u.id = m.user_id
         WHERE m.room_id = ? ORDER BY m.joined_at, u.id`,
      )
      .all(roomId) as unknown as UserRow[];
    return rows.map(toUser);
  }

  // ---- messages -------------------------------------------------------------------------

  async insertMessage(m: MessageRecord): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO messages (id, room_id, user_id, body, mentions, created_at, edited_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        m.id,
        m.roomId,
        m.userId,
        m.body,
        JSON.stringify(m.mentions),
        m.createdAt,
        m.editedAt,
        m.deletedAt,
      );
  }

  async findMessageById(id: string): Promise<MessageRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as
      MessageRow | undefined;
    return row && toMessage(row);
  }

  async updateMessageBody(id: string, body: string, editedAt: number): Promise<boolean> {
    return (
      this.db
        .prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(body, editedAt, id).changes > 0
    );
  }

  async softDeleteMessage(id: string, deletedAt: number): Promise<boolean> {
    return (
      this.db
        .prepare(
          "UPDATE messages SET body = '', deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .run(deletedAt, id).changes > 0
    );
  }

  async listMessages(roomId: string, options: ListMessagesOptions): Promise<MessageRecord[]> {
    const rows = (options.before === undefined
      ? this.db
          .prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?')
          .all(roomId, options.limit)
      : this.db
          .prepare('SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
          .all(roomId, options.before, options.limit)) as unknown as MessageRow[];
    return rows.map(toMessage);
  }
}
