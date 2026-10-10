import { MemoryStore, RateLimiter } from '@challenge/rate-limiter';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatError } from '../../src/core/errors.js';
import { ChatService, type ChatEvent } from '../../src/core/service.js';
import type { UserRecord } from '../../src/core/types.js';
import { SqliteChatRepository } from '../../src/store/sqlite-repository.js';
import { fakeClock, type FakeClock } from '../helpers/clock.js';
import { idFactory } from '../helpers/ids.js';

describe('ChatService', () => {
  let repo: SqliteChatRepository;
  let clock: FakeClock;
  let service: ChatService;
  let events: ChatEvent[];
  let alice: UserRecord;
  let bob: UserRecord;
  let root: UserRecord;

  beforeEach(async () => {
    repo = new SqliteChatRepository(':memory:');
    await repo.migrate();
    clock = fakeClock();
    const ids = idFactory(clock.now);
    const limiter = new RateLimiter({
      store: new MemoryStore({ now: clock.now, sweepIntervalMs: 0 }),
      algorithm: 'sliding-log',
      limits: {
        unauthenticated: { limit: 3, windowMs: 10_000 },
        authenticated: { limit: 3, windowMs: 10_000 },
      },
      now: clock.now,
    });
    service = new ChatService({ repository: repo, limiter, clock: clock.now, ids });
    events = [];
    service.events.on('event', (e: ChatEvent) => events.push(e));

    alice = await service.createUser({ username: 'alice', passwordHash: 'h', role: 'user' });
    bob = await service.createUser({ username: 'bob', passwordHash: 'h', role: 'user' });
    root = await service.createUser({ username: 'root', passwordHash: 'h', role: 'admin' });
  });

  const expectError = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toBeInstanceOf(ChatError);
    await expect(p).rejects.toMatchObject({ code });
  };

  describe('rooms', () => {
    it('creates a room with the creator as owner and first member', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      expect(room).toMatchObject({ name: 'general', visibility: 'public', ownerId: alice.id });
      expect(await repo.isMember(room.id, alice.id)).toBe(true);
      await expectError(
        service.createRoom(bob, { name: 'general', visibility: 'public' }),
        'conflict',
      );
    });

    it('lets anyone join a public room and returns a snapshot with members and recent history', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      await service.sendMessage(alice, room.id, 'first');
      clock.advance(1);
      await service.sendMessage(alice, room.id, 'second');
      events.length = 0;

      const snapshot = await service.joinRoom(bob, room.id);
      expect(snapshot.room).toEqual(room);
      expect(snapshot.members.map((u) => u.username)).toEqual(['alice', 'bob']);
      expect(snapshot.messages.map((m) => m.body)).toEqual(['first', 'second']); // oldest first
      expect(snapshot.messages[0]).toMatchObject({
        user: { id: alice.id, username: 'alice', role: 'user' },
        mentions: [],
        createdAt: new Date(clock.now() - 1).toISOString(),
        editedAt: null,
        deletedAt: null,
      });
      expect(events).toEqual([
        {
          type: 'room.joined',
          roomId: room.id,
          user: { id: bob.id, username: 'bob', role: 'user' },
        },
      ]);

      events.length = 0;
      await service.joinRoom(bob, room.id); // idempotent: no second event
      expect(events).toEqual([]);
    });

    it('restricts private rooms to members and admins', async () => {
      const room = await service.createRoom(alice, { name: 'secret', visibility: 'private' });
      await expectError(service.joinRoom(bob, room.id), 'forbidden');
      await expect(service.joinRoom(root, room.id)).resolves.toBeDefined();
      await service.addMember(alice, room.id, bob.id);
      await expect(service.joinRoom(bob, room.id)).resolves.toBeDefined();
      await expectError(service.addMember(bob, room.id, root.id), 'forbidden'); // bob is not the owner
      await expectError(service.joinRoom(bob, '01ARZ3NDEKTSV4RRFFQ69G5FAV'), 'not_found');
    });

    it('lists rooms visible to a user and leaves rooms with an event', async () => {
      const general = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      await service.createRoom(alice, { name: 'secret', visibility: 'private' });
      expect((await service.listRooms(bob)).map((r) => r.name)).toEqual(['general']);
      expect((await service.listRooms(alice)).map((r) => r.name)).toEqual(['general', 'secret']);

      await service.joinRoom(bob, general.id);
      events.length = 0;
      expect(await service.leaveRoom(bob, general.id)).toBe(true);
      expect(events).toEqual([
        {
          type: 'room.left',
          roomId: general.id,
          user: { id: bob.id, username: 'bob', role: 'user' },
        },
      ]);
      expect(await service.leaveRoom(bob, general.id)).toBe(false);
    });
  });

  describe('messages', () => {
    it('sends to a joined room, resolving mentions and emitting the message', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      await service.joinRoom(bob, room.id);
      events.length = 0;

      const message = await service.sendMessage(bob, room.id, 'hi @alice and @ghost');
      expect(message).toMatchObject({
        roomId: room.id,
        user: { username: 'bob' },
        body: 'hi @alice and @ghost',
        mentions: [{ id: alice.id, username: 'alice', role: 'user' }],
        createdAt: new Date(clock.now()).toISOString(),
      });
      expect(events).toEqual([
        { type: 'message.created', roomId: room.id, message, mentionedUserIds: [alice.id] },
      ]);
      expect((await repo.findMessageById(message.id))?.mentions).toEqual([alice.id]);
    });

    it('requires membership to send', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      await expectError(service.sendMessage(bob, room.id, 'hi'), 'not_joined');
    });

    it('rate limits sends per user using the injected limiter', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      for (let i = 0; i < 3; i++) await service.sendMessage(alice, room.id, `m${i}`);
      const blocked = service.sendMessage(alice, room.id, 'too fast');
      await expectError(blocked, 'rate_limited');
      await expect(blocked).rejects.toMatchObject({ retryAfterMs: 10_000 });
      expect(await repo.listMessages(room.id, { limit: 10 })).toHaveLength(3);

      clock.advance(10_000);
      await expect(service.sendMessage(alice, room.id, 'ok again')).resolves.toBeDefined();
    });

    it('lets the author or an admin edit, and emits the edit', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      const m = await service.sendMessage(alice, room.id, 'tpyo');
      events.length = 0;
      clock.advance(500);

      const edited = await service.editMessage(alice, m.id, 'typo');
      expect(edited).toMatchObject({
        id: m.id,
        roomId: room.id,
        body: 'typo',
        editedAt: new Date(clock.now()).toISOString(),
      });
      expect(events).toEqual([
        {
          type: 'message.edited',
          roomId: room.id,
          id: m.id,
          body: 'typo',
          editedAt: edited.editedAt,
        },
      ]);

      await expectError(service.editMessage(bob, m.id, 'hijack'), 'forbidden');
      await expect(service.editMessage(root, m.id, 'moderated')).resolves.toMatchObject({
        body: 'moderated',
      });
      await expectError(service.editMessage(alice, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'x'), 'not_found');
    });

    it('soft-deletes once, emits the deletion, and refuses later edits', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      const m = await service.sendMessage(alice, room.id, 'oops');
      events.length = 0;

      await expectError(service.deleteMessage(bob, m.id), 'forbidden');
      await service.deleteMessage(alice, m.id);
      expect(events).toEqual([{ type: 'message.deleted', roomId: room.id, id: m.id }]);
      await expectError(service.deleteMessage(alice, m.id), 'not_found');
      await expectError(service.editMessage(alice, m.id, 'x'), 'not_found');

      const history = await service.getHistory(alice, room.id, { limit: 10 });
      expect(history.messages[0]).toMatchObject({
        id: m.id,
        body: '',
        deletedAt: new Date(clock.now()).toISOString(),
      });
    });

    it('serves keyset-paginated history to users with access', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      for (let i = 0; i < 5; i++) {
        clock.advance(1);
        await service.sendMessage(alice, room.id, `m${i}`);
        clock.advance(4_000); // stay under the rate limit
      }
      const page1 = await service.getHistory(bob, room.id, { limit: 2 });
      expect(page1.messages.map((m) => m.body)).toEqual(['m4', 'm3']);
      expect(page1.nextCursor).toBe(page1.messages[1]!.id);
      const page2 = await service.getHistory(bob, room.id, { limit: 2, before: page1.nextCursor! });
      expect(page2.messages.map((m) => m.body)).toEqual(['m2', 'm1']);
      const page3 = await service.getHistory(bob, room.id, { limit: 2, before: page2.nextCursor! });
      expect(page3.messages.map((m) => m.body)).toEqual(['m0']);
      expect(page3.nextCursor).toBeNull();

      const secret = await service.createRoom(alice, { name: 'secret', visibility: 'private' });
      await expectError(service.getHistory(bob, secret.id, { limit: 2 }), 'forbidden');
      await expect(service.getHistory(root, secret.id, { limit: 2 })).resolves.toBeDefined();
    });
  });

  describe('administration', () => {
    it('bans and unbans users, blocking banned users from joining or sending', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      await service.joinRoom(bob, room.id);
      await expectError(service.banUser(alice, bob.id), 'forbidden');
      events.length = 0;

      await service.banUser(root, bob.id);
      expect(events).toEqual([{ type: 'user.banned', userId: bob.id }]);
      const bannedBob = (await repo.findUserById(bob.id))!;
      await expectError(service.sendMessage(bannedBob, room.id, 'hi'), 'banned');
      await expectError(service.joinRoom(bannedBob, room.id), 'banned');

      await service.unbanUser(root, bob.id);
      await expect(
        service.sendMessage((await repo.findUserById(bob.id))!, room.id, 'back'),
      ).resolves.toBeDefined();
      await expectError(service.banUser(root, '01ARZ3NDEKTSV4RRFFQ69G5FAV'), 'not_found');
    });

    it('deletes rooms and kicks members, emitting events for connected clients', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      await service.joinRoom(bob, room.id);
      events.length = 0;

      await expectError(service.kickUser(bob, room.id, alice.id), 'forbidden');
      await service.kickUser(root, room.id, bob.id);
      expect(events).toEqual([
        {
          type: 'member.kicked',
          roomId: room.id,
          user: { id: bob.id, username: 'bob', role: 'user' },
        },
      ]);
      expect(await repo.isMember(room.id, bob.id)).toBe(false);

      events.length = 0;
      await expectError(service.deleteRoom(bob, room.id), 'forbidden');
      await service.deleteRoom(root, room.id);
      expect(events).toEqual([
        {
          type: 'room.deleted',
          roomId: room.id,
          members: [{ id: alice.id, username: 'alice', role: 'user' }],
        },
      ]);
      await expectError(service.deleteRoom(root, room.id), 'not_found');
    });

    it('lists users and rooms with counts for admins only', async () => {
      const room = await service.createRoom(alice, { name: 'general', visibility: 'public' });
      await service.sendMessage(alice, room.id, 'hi');
      await expectError(service.listUsers(alice), 'forbidden');
      expect((await service.listUsers(root)).map((u) => u.username)).toEqual([
        'alice',
        'bob',
        'root',
      ]);
      expect(await service.listRoomsWithCounts(root)).toEqual([
        { room, memberCount: 1, messageCount: 1 },
      ]);
    });
  });
});
