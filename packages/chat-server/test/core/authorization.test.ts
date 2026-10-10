import { describe, expect, it } from 'vitest';
import {
  canJoinRoom,
  canManageRoom,
  canModifyMessage,
  isAdmin,
} from '../../src/core/authorization.js';
import type { MessageRecord, Room, User } from '../../src/core/types.js';

const alice: User = { id: 'A', username: 'alice', role: 'user' };
const bob: User = { id: 'B', username: 'bob', role: 'user' };
const root: User = { id: 'R', username: 'root', role: 'admin' };
const publicRoom: Room = {
  id: 'P',
  name: 'general',
  visibility: 'public',
  ownerId: 'A',
  createdAt: 0,
};
const privateRoom: Room = {
  id: 'S',
  name: 'secret',
  visibility: 'private',
  ownerId: 'A',
  createdAt: 0,
};
const message: MessageRecord = {
  id: 'M',
  roomId: 'P',
  userId: 'A',
  body: 'x',
  mentions: [],
  createdAt: 0,
  editedAt: null,
  deletedAt: null,
};

describe('authorization rules', () => {
  it('lets anyone join a public room, and only members or admins join a private one', () => {
    expect(canJoinRoom(publicRoom, bob, false)).toBe(true);
    expect(canJoinRoom(privateRoom, bob, false)).toBe(false);
    expect(canJoinRoom(privateRoom, bob, true)).toBe(true);
    expect(canJoinRoom(privateRoom, root, false)).toBe(true);
  });

  it('lets the author or an admin modify a message', () => {
    expect(canModifyMessage(message, alice)).toBe(true);
    expect(canModifyMessage(message, bob)).toBe(false);
    expect(canModifyMessage(message, root)).toBe(true);
  });

  it('lets the owner or an admin manage a room', () => {
    expect(canManageRoom(privateRoom, alice)).toBe(true);
    expect(canManageRoom(privateRoom, bob)).toBe(false);
    expect(canManageRoom(privateRoom, root)).toBe(true);
    expect(isAdmin(root)).toBe(true);
    expect(isAdmin(alice)).toBe(false);
  });
});
