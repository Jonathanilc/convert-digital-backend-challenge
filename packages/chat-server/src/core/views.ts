import type { MessageRecord, User, UserRecord } from './types.js';

/** Wire shape of a message, matching `Message` in asyncapi.yaml and openapi.yaml. */
export interface MessageView {
  id: string;
  roomId: string;
  user: User;
  body: string;
  mentions: User[];
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export const toUserView = (u: User | UserRecord): User => ({
  id: u.id,
  username: u.username,
  role: u.role,
});

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Users are looked up in bulk by the caller; an unknown author (deleted account) degrades gracefully. */
export function toMessageView(record: MessageRecord, usersById: Map<string, User>): MessageView {
  const user = usersById.get(record.userId) ?? {
    id: record.userId,
    username: 'unknown',
    role: 'user' as const,
  };
  return {
    id: record.id,
    roomId: record.roomId,
    user,
    body: record.body,
    mentions: record.mentions
      .map((id) => usersById.get(id))
      .filter((u): u is User => u !== undefined),
    createdAt: new Date(record.createdAt).toISOString(),
    editedAt: iso(record.editedAt),
    deletedAt: iso(record.deletedAt),
  };
}
