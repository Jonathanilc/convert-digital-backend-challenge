import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UniqueConstraintError, type MessageRecord } from '../../src/core/types.js';
import { SqliteChatRepository } from '../../src/store/sqlite-repository.js';
import { fakeClock, type FakeClock } from '../helpers/clock.js';
import { idFactory } from '../helpers/ids.js';

describe('SqliteChatRepository', () => {
  let dir: string;
  let repo: SqliteChatRepository;
  let clock: FakeClock;
  let id: () => string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-repo-'));
    repo = new SqliteChatRepository(join(dir, 'chat.db'));
    await repo.migrate();
    clock = fakeClock();
    id = idFactory(clock.now);
  });

  afterEach(async () => {
    await repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const user = async (username: string, role: 'user' | 'admin' = 'user') =>
    repo.createUser({
      id: id(),
      username,
      passwordHash: `hash-${username}`,
      role,
      createdAt: clock.now(),
    });
  const room = async (name: string, ownerId: string, visibility: 'public' | 'private' = 'public') =>
    repo.createRoom({ id: id(), name, visibility, ownerId, createdAt: clock.now() });
  const message = (
    roomId: string,
    userId: string,
    body: string,
    mentions: string[] = [],
  ): MessageRecord => ({
    id: id(),
    roomId,
    userId,
    body,
    mentions,
    createdAt: clock.now(),
    editedAt: null,
    deletedAt: null,
  });

  it('migrates idempotently and reports its schema version', async () => {
    await repo.migrate();
    expect(repo.schemaVersion()).toBe(1);
  });

  it('works on an in-memory database too', async () => {
    const mem = new SqliteChatRepository(':memory:');
    await mem.migrate();
    await mem.createUser({
      id: id(),
      username: 'mem',
      passwordHash: 'h',
      role: 'user',
      createdAt: 1,
    });
    expect((await mem.findUserByUsername('mem'))?.username).toBe('mem');
    await mem.close();
  });

  describe('users', () => {
    it('creates and finds users by id and username', async () => {
      const alice = await user('alice', 'admin');
      expect(alice).toMatchObject({
        username: 'alice',
        role: 'admin',
        passwordHash: 'hash-alice',
        bannedAt: null,
      });
      expect(await repo.findUserById(alice.id)).toEqual(alice);
      expect(await repo.findUserByUsername('alice')).toEqual(alice);
      expect(await repo.findUserByUsername('nobody')).toBeUndefined();
    });

    it('rejects duplicate usernames with a typed error', async () => {
      await user('alice');
      await expect(user('alice')).rejects.toBeInstanceOf(UniqueConstraintError);
      await expect(user('alice')).rejects.toMatchObject({ field: 'username' });
    });

    it('lists users in creation order and resolves many by username or id', async () => {
      const a = await user('alice');
      clock.advance(1);
      const b = await user('bob');
      expect((await repo.listUsers()).map((u) => u.username)).toEqual(['alice', 'bob']);
      expect(
        (await repo.findUsersByUsernames(['bob', 'alice', 'ghost'])).map((u) => u.username).sort(),
      ).toEqual(['alice', 'bob']);
      expect((await repo.findUsersByIds([b.id, a.id])).map((u) => u.id).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      expect(await repo.findUsersByUsernames([])).toEqual([]);
    });

    it('bans and unbans', async () => {
      const a = await user('alice');
      expect(await repo.setBanned(a.id, 1_234)).toBe(true);
      expect((await repo.findUserById(a.id))?.bannedAt).toBe(1_234);
      expect(await repo.setBanned(a.id, null)).toBe(true);
      expect((await repo.findUserById(a.id))?.bannedAt).toBeNull();
      expect(await repo.setBanned('01ARZ3NDEKTSV4RRFFQ69G5FAV', 1)).toBe(false);
    });
  });

  describe('rooms and membership', () => {
    it('creates rooms, enforces unique names, lists visible rooms', async () => {
      const owner = await user('owner');
      const alice = await user('alice');
      const general = await room('general', owner.id);
      clock.advance(1);
      const secret = await room('secret', owner.id, 'private');
      await expect(room('general', owner.id)).rejects.toMatchObject({ field: 'name' });

      expect(await repo.findRoomByName('secret')).toEqual(secret);
      expect((await repo.listRooms()).map((r) => r.name)).toEqual(['general', 'secret']);
      expect((await repo.listRoomsVisibleTo(alice.id)).map((r) => r.name)).toEqual(['general']);
      await repo.addMember(secret.id, alice.id, clock.now());
      expect((await repo.listRoomsVisibleTo(alice.id)).map((r) => r.name)).toEqual([
        'general',
        'secret',
      ]);
    });

    it('manages members idempotently and in join order', async () => {
      const owner = await user('owner');
      const alice = await user('alice');
      const general = await room('general', owner.id);
      await repo.addMember(general.id, owner.id, clock.now());
      clock.advance(5);
      await repo.addMember(general.id, alice.id, clock.now());
      await repo.addMember(general.id, alice.id, clock.now()); // no-op
      expect((await repo.listMembers(general.id)).map((u) => u.username)).toEqual([
        'owner',
        'alice',
      ]);
      expect(await repo.isMember(general.id, alice.id)).toBe(true);
      expect(await repo.removeMember(general.id, alice.id)).toBe(true);
      expect(await repo.removeMember(general.id, alice.id)).toBe(false);
      expect(await repo.isMember(general.id, alice.id)).toBe(false);
    });

    it('deletes a room with its members and messages, and reports counts', async () => {
      const owner = await user('owner');
      const general = await room('general', owner.id);
      await repo.addMember(general.id, owner.id, clock.now());
      await repo.insertMessage(message(general.id, owner.id, 'hello'));
      await repo.insertMessage(message(general.id, owner.id, 'again'));
      expect(await repo.listRoomsWithCounts()).toEqual([
        { room: general, memberCount: 1, messageCount: 2 },
      ]);

      expect(await repo.deleteRoom(general.id)).toBe(true);
      expect(await repo.deleteRoom(general.id)).toBe(false);
      expect(await repo.findRoomById(general.id)).toBeUndefined();
      expect(await repo.listMembers(general.id)).toEqual([]);
      expect(await repo.listMessages(general.id, { limit: 10 })).toEqual([]);
    });
  });

  describe('messages', () => {
    it('stores and reads messages with mentions, newest first', async () => {
      const owner = await user('owner');
      const alice = await user('alice');
      const general = await room('general', owner.id);
      const first = message(general.id, owner.id, 'hi @alice', [alice.id]);
      await repo.insertMessage(first);
      clock.advance(10);
      const second = message(general.id, alice.id, 'hello');
      await repo.insertMessage(second);

      expect(await repo.findMessageById(first.id)).toEqual(first);
      expect(await repo.listMessages(general.id, { limit: 10 })).toEqual([second, first]);
    });

    it('paginates by keyset: before = the oldest id already seen', async () => {
      const owner = await user('owner');
      const general = await room('general', owner.id);
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const m = message(general.id, owner.id, `m${i}`);
        ids.push(m.id);
        await repo.insertMessage(m);
        clock.advance(1);
      }
      const page1 = await repo.listMessages(general.id, { limit: 3 });
      expect(page1.map((m) => m.body)).toEqual(['m6', 'm5', 'm4']);
      const page2 = await repo.listMessages(general.id, { limit: 3, before: page1.at(-1)!.id });
      expect(page2.map((m) => m.body)).toEqual(['m3', 'm2', 'm1']);
      const page3 = await repo.listMessages(general.id, { limit: 3, before: page2.at(-1)!.id });
      expect(page3.map((m) => m.body)).toEqual(['m0']);
      expect(ids).toHaveLength(7);
    });

    it('edits and soft-deletes, keeping tombstones in history', async () => {
      const owner = await user('owner');
      const general = await room('general', owner.id);
      const m = message(general.id, owner.id, 'typo');
      await repo.insertMessage(m);
      expect(await repo.updateMessageBody(m.id, 'fixed', 1_500)).toBe(true);
      expect(await repo.findMessageById(m.id)).toMatchObject({ body: 'fixed', editedAt: 1_500 });
      expect(await repo.softDeleteMessage(m.id, 1_600)).toBe(true);
      expect(await repo.findMessageById(m.id)).toMatchObject({ body: '', deletedAt: 1_600 });
      expect((await repo.listMessages(general.id, { limit: 5 })).map((x) => x.deletedAt)).toEqual([
        1_600,
      ]);
      expect(await repo.updateMessageBody('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'x', 1)).toBe(false);
    });
  });
});
