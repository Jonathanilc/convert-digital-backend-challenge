import { EventEmitter } from 'node:events';
import type { RateLimiter } from '@challenge/rate-limiter';
import type { ChatRepository, RoomWithCounts } from '../store/repository.js';
import { canJoinRoom, canManageRoom, canModifyMessage, isAdmin } from './authorization.js';
import { ChatError } from './errors.js';
import { extractMentionUsernames } from './mentions.js';
import {
  UniqueConstraintError,
  type MessageRecord,
  type Role,
  type Room,
  type User,
  type UserRecord,
  type Visibility,
} from './types.js';
import { toMessageView, toUserView, type MessageView } from './views.js';

export type ChatEvent =
  | { type: 'room.joined'; roomId: string; user: User }
  | { type: 'room.left'; roomId: string; user: User }
  | { type: 'message.created'; roomId: string; message: MessageView; mentionedUserIds: string[] }
  | { type: 'message.edited'; roomId: string; id: string; body: string; editedAt: string }
  | { type: 'message.deleted'; roomId: string; id: string }
  | { type: 'user.banned'; userId: string }
  | { type: 'room.deleted'; roomId: string; members: User[] }
  | { type: 'member.kicked'; roomId: string; user: User };

export interface RoomSnapshot {
  room: Room;
  members: User[];
  /** Oldest first. */
  messages: MessageView[];
}

export interface HistoryPage {
  /** Newest first. */
  messages: MessageView[];
  nextCursor: string | null;
}

export interface ChatServiceDeps {
  repository: ChatRepository;
  /** Message-send limiter; identity is the user, rule key `ws:send`. */
  limiter: RateLimiter;
  clock: () => number;
  ids: () => string;
  /** Messages included in a join snapshot. Defaults to 50. */
  snapshotSize?: number;
}

/**
 * All chat behaviour, independent of transport. The WebSocket layer and the HTTP layer are thin
 * adapters over these methods; both observe `events` to fan out to connected clients.
 */
export class ChatService {
  readonly events = new EventEmitter<{ event: [ChatEvent] }>();
  private readonly repo: ChatRepository;
  private readonly limiter: RateLimiter;
  private readonly clock: () => number;
  private readonly ids: () => string;
  private readonly snapshotSize: number;

  constructor(deps: ChatServiceDeps) {
    this.repo = deps.repository;
    this.limiter = deps.limiter;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.snapshotSize = deps.snapshotSize ?? 50;
  }

  // ---- users ----------------------------------------------------------------------------

  async createUser(input: {
    username: string;
    passwordHash: string;
    role: Role;
  }): Promise<UserRecord> {
    try {
      return await this.repo.createUser({ id: this.ids(), createdAt: this.clock(), ...input });
    } catch (error) {
      throw translateConflict(error, 'Username already taken');
    }
  }

  // ---- rooms ----------------------------------------------------------------------------

  async createRoom(
    user: UserRecord,
    input: { name: string; visibility: Visibility },
  ): Promise<Room> {
    assertNotBanned(user);
    let room: Room;
    try {
      room = await this.repo.createRoom({
        id: this.ids(),
        createdAt: this.clock(),
        ownerId: user.id,
        ...input,
      });
    } catch (error) {
      throw translateConflict(error, 'Room name already taken');
    }
    await this.repo.addMember(room.id, user.id, this.clock());
    return room;
  }

  async listRooms(user: UserRecord): Promise<Room[]> {
    return isAdmin(user) ? this.repo.listRooms() : this.repo.listRoomsVisibleTo(user.id);
  }

  async getRoom(user: UserRecord, roomId: string): Promise<{ room: Room; members: User[] }> {
    const room = await this.requireRoom(roomId);
    await this.assertCanAccess(room, user);
    return { room, members: (await this.repo.listMembers(room.id)).map(toUserView) };
  }

  async joinRoom(user: UserRecord, roomId: string): Promise<RoomSnapshot> {
    assertNotBanned(user);
    const room = await this.requireRoom(roomId);
    const member = await this.repo.isMember(room.id, user.id);
    if (!canJoinRoom(room, user, member)) throw new ChatError('forbidden', 'This room is private');
    if (!member) {
      await this.repo.addMember(room.id, user.id, this.clock());
      this.emit({ type: 'room.joined', roomId: room.id, user: toUserView(user) });
    }
    const recent = await this.repo.listMessages(room.id, { limit: this.snapshotSize });
    return {
      room,
      members: (await this.repo.listMembers(room.id)).map(toUserView),
      messages: (await this.toViews(recent)).reverse(),
    };
  }

  async leaveRoom(user: UserRecord, roomId: string): Promise<boolean> {
    const removed = await this.repo.removeMember(roomId, user.id);
    if (removed) this.emit({ type: 'room.left', roomId, user: toUserView(user) });
    return removed;
  }

  async addMember(actor: UserRecord, roomId: string, userId: string): Promise<void> {
    const room = await this.requireRoom(roomId);
    if (!canManageRoom(room, actor))
      throw new ChatError('forbidden', 'Only the owner or an admin can add members');
    if (!(await this.repo.findUserById(userId))) throw new ChatError('not_found', 'No such user');
    await this.repo.addMember(room.id, userId, this.clock());
  }

  // ---- messages -------------------------------------------------------------------------

  async sendMessage(user: UserRecord, roomId: string, body: string): Promise<MessageView> {
    assertNotBanned(user);
    const room = await this.requireRoom(roomId);
    if (!(await this.repo.isMember(room.id, user.id)))
      throw new ChatError('not_joined', 'Join the room before sending');

    const decision = await this.limiter.check({
      identity: { key: `user:${user.id}`, tier: 'authenticated', userId: user.id },
      path: 'ws:send',
      method: 'SEND',
    });
    if (!decision.allowed) {
      throw new ChatError('rate_limited', 'Too many messages, slow down', {
        retryAfterMs: decision.retryAfterMs ?? 0,
      });
    }

    const mentioned = await this.repo.findUsersByUsernames(extractMentionUsernames(body));
    const record: MessageRecord = {
      id: this.ids(),
      roomId: room.id,
      userId: user.id,
      body,
      mentions: mentioned.map((u) => u.id),
      createdAt: this.clock(),
      editedAt: null,
      deletedAt: null,
    };
    await this.repo.insertMessage(record);

    const usersById = new Map<string, User>([
      [user.id, toUserView(user)],
      ...mentioned.map((u): [string, User] => [u.id, toUserView(u)]),
    ]);
    const message = toMessageView(record, usersById);
    this.emit({
      type: 'message.created',
      roomId: room.id,
      message,
      mentionedUserIds: record.mentions,
    });
    return message;
  }

  async editMessage(user: UserRecord, messageId: string, body: string): Promise<MessageView> {
    const record = await this.requireLiveMessage(messageId);
    if (!canModifyMessage(record, user))
      throw new ChatError('forbidden', 'Only the author or an admin can edit');
    const editedAt = this.clock();
    await this.repo.updateMessageBody(record.id, body, editedAt);
    const [view] = await this.toViews([{ ...record, body, editedAt }]);
    this.emit({
      type: 'message.edited',
      roomId: record.roomId,
      id: record.id,
      body,
      editedAt: view!.editedAt as string,
    });
    return view!;
  }

  async deleteMessage(user: UserRecord, messageId: string): Promise<void> {
    const record = await this.requireLiveMessage(messageId);
    if (!canModifyMessage(record, user))
      throw new ChatError('forbidden', 'Only the author or an admin can delete');
    await this.repo.softDeleteMessage(record.id, this.clock());
    this.emit({ type: 'message.deleted', roomId: record.roomId, id: record.id });
  }

  async getHistory(
    user: UserRecord,
    roomId: string,
    options: { before?: string; limit: number },
  ): Promise<HistoryPage> {
    const room = await this.requireRoom(roomId);
    await this.assertCanAccess(room, user);
    const records = await this.repo.listMessages(room.id, options);
    const messages = await this.toViews(records);
    const last = messages.at(-1);
    return { messages, nextCursor: records.length === options.limit && last ? last.id : null };
  }

  // ---- administration -------------------------------------------------------------------

  async banUser(actor: UserRecord, userId: string): Promise<void> {
    requireAdmin(actor);
    if (!(await this.repo.setBanned(userId, this.clock())))
      throw new ChatError('not_found', 'No such user');
    this.emit({ type: 'user.banned', userId });
  }

  async unbanUser(actor: UserRecord, userId: string): Promise<void> {
    requireAdmin(actor);
    if (!(await this.repo.setBanned(userId, null)))
      throw new ChatError('not_found', 'No such user');
  }

  async deleteRoom(actor: UserRecord, roomId: string): Promise<void> {
    const room = await this.requireRoom(roomId);
    if (!canManageRoom(room, actor))
      throw new ChatError('forbidden', 'Only the owner or an admin can delete a room');
    const members = (await this.repo.listMembers(room.id)).map(toUserView);
    await this.repo.deleteRoom(room.id);
    this.emit({ type: 'room.deleted', roomId: room.id, members });
  }

  async kickUser(actor: UserRecord, roomId: string, userId: string): Promise<void> {
    const room = await this.requireRoom(roomId);
    if (!canManageRoom(room, actor))
      throw new ChatError('forbidden', 'Only the owner or an admin can kick');
    const target = await this.repo.findUserById(userId);
    if (!target) throw new ChatError('not_found', 'No such user');
    if (await this.repo.removeMember(room.id, userId))
      this.emit({ type: 'member.kicked', roomId: room.id, user: toUserView(target) });
  }

  async listUsers(actor: UserRecord): Promise<UserRecord[]> {
    requireAdmin(actor);
    return this.repo.listUsers();
  }

  async listRoomsWithCounts(actor: UserRecord): Promise<RoomWithCounts[]> {
    requireAdmin(actor);
    return this.repo.listRoomsWithCounts();
  }

  // ---- helpers --------------------------------------------------------------------------

  private emit(event: ChatEvent): void {
    this.events.emit('event', event);
  }

  private async requireRoom(roomId: string): Promise<Room> {
    const room = await this.repo.findRoomById(roomId);
    if (!room) throw new ChatError('not_found', 'No such room');
    return room;
  }

  private async requireLiveMessage(messageId: string): Promise<MessageRecord> {
    const record = await this.repo.findMessageById(messageId);
    if (!record || record.deletedAt !== null) throw new ChatError('not_found', 'No such message');
    return record;
  }

  private async assertCanAccess(room: Room, user: UserRecord): Promise<void> {
    if (room.visibility === 'public' || isAdmin(user)) return;
    if (!(await this.repo.isMember(room.id, user.id)))
      throw new ChatError('forbidden', 'This room is private');
  }

  /** Resolves authors and mentioned users in one query per batch. */
  private async toViews(records: MessageRecord[]): Promise<MessageView[]> {
    const ids = new Set<string>();
    for (const r of records) {
      ids.add(r.userId);
      for (const m of r.mentions) ids.add(m);
    }
    const users = await this.repo.findUsersByIds([...ids]);
    const usersById = new Map(users.map((u): [string, User] => [u.id, toUserView(u)]));
    return records.map((r) => toMessageView(r, usersById));
  }
}

function assertNotBanned(user: UserRecord): void {
  if (user.bannedAt !== null) throw new ChatError('banned', 'This account is banned');
}

function requireAdmin(user: UserRecord): void {
  if (!isAdmin(user)) throw new ChatError('forbidden', 'Admin role required');
}

function translateConflict(error: unknown, message: string): unknown {
  return error instanceof UniqueConstraintError ? new ChatError('conflict', message) : error;
}
