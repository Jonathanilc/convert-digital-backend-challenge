import type { MessageRecord, Room, User } from './types.js';

export const isAdmin = (user: User): boolean => user.role === 'admin';

/** Public rooms are open; private rooms need membership. Admins can go anywhere. */
export function canJoinRoom(room: Room, user: User, isMember: boolean): boolean {
  return room.visibility === 'public' || isMember || isAdmin(user);
}

/** The author or an admin may edit or delete a message. */
export function canModifyMessage(message: MessageRecord, user: User): boolean {
  return message.userId === user.id || isAdmin(user);
}

/** The owner or an admin manages a room (membership of private rooms, deletion). */
export function canManageRoom(room: Room, user: User): boolean {
  return room.ownerId === user.id || isAdmin(user);
}
