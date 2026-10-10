import type { MessageRecord, Role, Room, UserRecord, Visibility } from '../core/types.js';

export interface CreateUserInput {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
}

export interface CreateRoomInput {
  id: string;
  name: string;
  visibility: Visibility;
  ownerId: string;
  createdAt: number;
}

export interface ListMessagesOptions {
  /** Return messages with id < before (older). Omit for the newest page. */
  before?: string;
  limit: number;
}

export interface RoomWithCounts {
  room: Room;
  memberCount: number;
  messageCount: number;
}

/**
 * Persistence port. The API is async so a Postgres implementation can slot in; the SQLite
 * implementation is synchronous under the hood. Pagination is keyset-based on time-sortable ids.
 */
export interface ChatRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;

  createUser(input: CreateUserInput): Promise<UserRecord>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  findUserByUsername(username: string): Promise<UserRecord | undefined>;
  findUsersByIds(ids: string[]): Promise<UserRecord[]>;
  findUsersByUsernames(usernames: string[]): Promise<UserRecord[]>;
  listUsers(): Promise<UserRecord[]>;
  setBanned(userId: string, bannedAt: number | null): Promise<boolean>;

  createRoom(input: CreateRoomInput): Promise<Room>;
  findRoomById(id: string): Promise<Room | undefined>;
  findRoomByName(name: string): Promise<Room | undefined>;
  listRooms(): Promise<Room[]>;
  /** Public rooms plus private rooms the user is a member of, by creation time. */
  listRoomsVisibleTo(userId: string): Promise<Room[]>;
  listRoomsWithCounts(): Promise<RoomWithCounts[]>;
  deleteRoom(id: string): Promise<boolean>;

  addMember(roomId: string, userId: string, joinedAt: number): Promise<void>;
  removeMember(roomId: string, userId: string): Promise<boolean>;
  isMember(roomId: string, userId: string): Promise<boolean>;
  listMembers(roomId: string): Promise<UserRecord[]>;

  insertMessage(message: MessageRecord): Promise<void>;
  findMessageById(id: string): Promise<MessageRecord | undefined>;
  updateMessageBody(id: string, body: string, editedAt: number): Promise<boolean>;
  softDeleteMessage(id: string, deletedAt: number): Promise<boolean>;
  /** Newest first. */
  listMessages(roomId: string, options: ListMessagesOptions): Promise<MessageRecord[]>;
}
