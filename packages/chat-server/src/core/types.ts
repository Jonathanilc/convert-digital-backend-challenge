/** Domain types for the chat server. Timestamps are epoch milliseconds; the wire uses ISO strings. */

export type Role = 'user' | 'admin';
export type Visibility = 'public' | 'private';

export interface User {
  id: string;
  username: string;
  role: Role;
}

export interface UserRecord extends User {
  passwordHash: string;
  bannedAt: number | null;
  createdAt: number;
}

export interface Room {
  id: string;
  name: string;
  visibility: Visibility;
  ownerId: string;
  createdAt: number;
}

export interface MessageRecord {
  id: string;
  roomId: string;
  userId: string;
  body: string;
  /** Ids of mentioned users, resolved when the message was sent. */
  mentions: string[];
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

/** Thrown by the repository when a UNIQUE constraint is violated. */
export class UniqueConstraintError extends Error {
  constructor(
    readonly field: string,
    message = `${field} already exists`,
  ) {
    super(message);
    this.name = 'UniqueConstraintError';
  }
}
