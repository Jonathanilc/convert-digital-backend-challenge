import { afterEach, describe, expect, it } from 'vitest';
import { boot, type Booted } from '../helpers/boot.js';
import { expectContract, expectSchema } from '../helpers/contract.js';

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('chat HTTP API (real server, real Redis, real SQLite)', () => {
  let booted: Booted;
  afterEach(async () => {
    await booted?.close();
  });

  describe('meta', () => {
    it('reports health, readiness, and serves both contracts and the docs page', async () => {
      booted = await boot();
      const health = await booted.api.get('/health', { expect: 200 });
      expect(health.body).toEqual({ status: 'ok', checks: { redis: 'up', database: 'up' } });
      await expectContract(health, 'GET', '/health');

      const ready = await booted.api.get('/ready', { expect: 200 });
      expect(ready.body).toEqual({ status: 'ready', checks: { redis: 'up', database: 'up' } });
      await expectContract(ready, 'GET', '/ready');

      const openapi = await booted.api.get('/openapi.json', { expect: 200 });
      expect(openapi.body.info.title).toBe('Chat Server HTTP API');
      await expectContract(openapi, 'GET', '/openapi.json');

      const asyncapi = await booted.api.get('/asyncapi.yaml', { expect: 200 });
      expect(asyncapi.text).toContain('asyncapi: 3.0.0');
      await expectContract(asyncapi, 'GET', '/asyncapi.yaml');

      const docs = await booted.api.get('/docs', { expect: 200 });
      expect(docs.text).toContain('swagger-ui');
      expect(docs.text).toContain('/asyncapi.yaml');
      await expectContract(docs, 'GET', '/docs');
    });
  });

  describe('accounts', () => {
    it('registers, logs in, and identifies the caller', async () => {
      booted = await boot();
      const registered = await booted.api.post(
        '/auth/register',
        { username: 'carol', password: 'carol-password' },
        { expect: 201 },
      );
      expect(registered.body.user).toMatchObject({ username: 'carol', role: 'user' });
      expect(registered.headers['ratelimit-limit']).toBe('20');
      await expectContract(registered, 'POST', '/auth/register');

      const login = await booted.api.post(
        '/auth/login',
        { username: 'carol', password: 'carol-password' },
        { expect: 200 },
      );
      await expectContract(login, 'POST', '/auth/login');

      const me = await booted.api.get('/me', { ...bearer(login.body.token), expect: 200 });
      expect(me.body).toEqual(registered.body.user);
      await expectContract(me, 'GET', '/me');
    });

    it('validates credentials against the contract and rejects duplicates', async () => {
      booted = await boot();
      const short = await booted.api.post(
        '/auth/register',
        { username: 'carol', password: 'short' },
        { expect: 400 },
      );
      expect(short.body.details?.[0]?.path).toMatch(/password/);
      await expectContract(short, 'POST', '/auth/register');
      const bad = await booted.api.post(
        '/auth/register',
        { username: 'Not Valid!', password: 'carol-password' },
        { expect: 400 },
      );
      await expectContract(bad, 'POST', '/auth/register');
      const dup = await booted.api.post(
        '/auth/register',
        { username: 'alice', password: 'whatever-long' },
        { expect: 409 },
      );
      await expectContract(dup, 'POST', '/auth/register');
    });

    it('refuses wrong passwords, unknown users, bad tokens and banned users', async () => {
      booted = await boot();
      await expectContract(
        await booted.api.post(
          '/auth/login',
          { username: 'alice', password: 'wrong-password' },
          { expect: 401 },
        ),
        'POST',
        '/auth/login',
      );
      await expectContract(
        await booted.api.post(
          '/auth/login',
          { username: 'ghost', password: 'wrong-password' },
          { expect: 401 },
        ),
        'POST',
        '/auth/login',
      );
      await expectContract(await booted.api.get('/me', { expect: 401 }), 'GET', '/me');
      await expectContract(
        await booted.api.get('/me', { ...bearer('garbage'), expect: 401 }),
        'GET',
        '/me',
      );

      const admin = await booted.login('admin', 'admin-password');
      const bobToken = await booted.login('bob', 'bob-builder');
      const bobId = (await booted.api.get('/me', bearer(bobToken))).body.id;
      await booted.api.put(`/admin/users/${bobId}/ban`, { ...bearer(admin), expect: 204 });
      await expectContract(
        await booted.api.post(
          '/auth/login',
          { username: 'bob', password: 'bob-builder' },
          { expect: 403 },
        ),
        'POST',
        '/auth/login',
      );
      await expectContract(
        await booted.api.get('/me', { ...bearer(bobToken), expect: 403 }),
        'GET',
        '/me',
      );
    });

    it('rate limits login attempts per IP with the standard headers', async () => {
      booted = await boot({ loginLimit: { limit: 3, windowMs: 60_000 } });
      for (let i = 0; i < 3; i++)
        await booted.api.post(
          '/auth/login',
          { username: 'alice', password: 'wrong-password' },
          { expect: 401 },
        );
      const blocked = await booted.api.post(
        '/auth/login',
        { username: 'alice', password: 'wonderland' },
        { expect: 429 },
      );
      expect(blocked.headers['retry-after']).toBe('60');
      await expectContract(blocked, 'POST', '/auth/login');
      booted.clock.advance(60_000);
      await booted.api.post(
        '/auth/login',
        { username: 'alice', password: 'wonderland' },
        { expect: 200 },
      );
    });
  });

  describe('rooms', () => {
    it('lists the seeded room, creates rooms, and shows details with members', async () => {
      booted = await boot();
      const alice = await booted.login('alice', 'wonderland');
      const list = await booted.api.get('/rooms', { ...bearer(alice), expect: 200 });
      expect(list.body.rooms.map((r: { name: string }) => r.name)).toEqual(['general']);
      await expectContract(list, 'GET', '/rooms');

      const created = await booted.api.post(
        '/rooms',
        { name: 'design', visibility: 'private' },
        { ...bearer(alice), expect: 201 },
      );
      expect(created.body).toMatchObject({ name: 'design', visibility: 'private' });
      await expectContract(created, 'POST', '/rooms');
      await expectContract(
        await booted.api.post('/rooms', { name: 'design' }, { ...bearer(alice), expect: 409 }),
        'POST',
        '/rooms',
      );
      await expectContract(
        await booted.api.post('/rooms', { name: 'Bad Name' }, { ...bearer(alice), expect: 400 }),
        'POST',
        '/rooms',
      );

      const details = await booted.api.get(`/rooms/${created.body.id}`, {
        ...bearer(alice),
        expect: 200,
      });
      expect(details.body.members.map((m: { username: string }) => m.username)).toEqual(['alice']);
      await expectContract(details, 'GET', '/rooms/{roomId}');
    });

    it('keeps private rooms hidden until membership is granted by the owner', async () => {
      booted = await boot();
      const alice = await booted.login('alice', 'wonderland');
      const bob = await booted.login('bob', 'bob-builder');
      const bobId = (await booted.api.get('/me', bearer(bob))).body.id;
      const secret = (
        await booted.api.post(
          '/rooms',
          { name: 'secret', visibility: 'private' },
          { ...bearer(alice), expect: 201 },
        )
      ).body;

      expect(
        (await booted.api.get('/rooms', bearer(bob))).body.rooms.map(
          (r: { name: string }) => r.name,
        ),
      ).toEqual(['general']);
      await expectContract(
        await booted.api.get(`/rooms/${secret.id}`, { ...bearer(bob), expect: 403 }),
        'GET',
        '/rooms/{roomId}',
      );
      await expectContract(
        await booted.api.post(
          `/rooms/${secret.id}/members`,
          { userId: bobId },
          { ...bearer(bob), expect: 403 },
        ),
        'POST',
        '/rooms/{roomId}/members',
      );

      await booted.api.post(
        `/rooms/${secret.id}/members`,
        { userId: bobId },
        { ...bearer(alice), expect: 204 },
      );
      expect(
        (await booted.api.get('/rooms', bearer(bob))).body.rooms.map(
          (r: { name: string }) => r.name,
        ),
      ).toEqual(['general', 'secret']);
      await expectContract(
        await booted.api.get('/rooms/01ARZ3NDEKTSV4RRFFQ69G5FAV', { ...bearer(bob), expect: 404 }),
        'GET',
        '/rooms/{roomId}',
      );
    });
  });

  describe('history', () => {
    it('pages newest-first by cursor and keeps tombstones', async () => {
      booted = await boot({ messageLimit: { limit: 100, windowMs: 1_000 } });
      const aliceToken = await booted.login('alice', 'wonderland');
      const general = (await booted.api.get('/rooms', bearer(aliceToken))).body.rooms[0];
      const alice = (await booted.repository.findUserByUsername('alice'))!;
      await booted.chat.service.joinRoom(alice, general.id);
      const sent = [];
      for (let i = 0; i < 5; i++) {
        booted.clock.advance(1);
        sent.push(await booted.chat.service.sendMessage(alice, general.id, `m${i}`));
      }
      await booted.chat.service.deleteMessage(alice, sent[2]!.id);

      const page1 = await booted.api.get(`/rooms/${general.id}/messages?limit=2`, {
        ...bearer(aliceToken),
        expect: 200,
      });
      expect(page1.body.messages.map((m: { body: string }) => m.body)).toEqual(['m4', 'm3']);
      expect(page1.body.nextCursor).toBe(sent[3]!.id);
      await expectContract(page1, 'GET', '/rooms/{roomId}/messages');

      const page2 = await booted.api.get(
        `/rooms/${general.id}/messages?limit=2&before=${page1.body.nextCursor}`,
        { ...bearer(aliceToken), expect: 200 },
      );
      expect(page2.body.messages[0]).toMatchObject({
        id: sent[2]!.id,
        body: '',
        deletedAt: expect.any(String),
      });
      expect(page2.body.messages[1].body).toBe('m1');

      const page3 = await booted.api.get(
        `/rooms/${general.id}/messages?limit=2&before=${page2.body.nextCursor}`,
        { ...bearer(aliceToken), expect: 200 },
      );
      expect(page3.body.messages.map((m: { body: string }) => m.body)).toEqual(['m0']);
      expect(page3.body.nextCursor).toBeNull();

      await expectContract(
        await booted.api.get(`/rooms/${general.id}/messages?limit=0`, {
          ...bearer(aliceToken),
          expect: 400,
        }),
        'GET',
        '/rooms/{roomId}/messages',
      );
    });
  });

  describe('admin', () => {
    it('is forbidden for regular users and lists users and rooms for admins', async () => {
      booted = await boot();
      const alice = await booted.login('alice', 'wonderland');
      const admin = await booted.login('admin', 'admin-password');
      await expectContract(
        await booted.api.get('/admin/users', { ...bearer(alice), expect: 403 }),
        'GET',
        '/admin/users',
      );

      const users = await booted.api.get('/admin/users', { ...bearer(admin), expect: 200 });
      expect(users.body.users.map((u: { username: string }) => u.username)).toEqual([
        'admin',
        'alice',
        'bob',
      ]);
      await expectContract(users, 'GET', '/admin/users');

      const rooms = await booted.api.get('/admin/rooms', { ...bearer(admin), expect: 200 });
      expect(rooms.body.rooms[0]).toMatchObject({
        room: { name: 'general' },
        memberCount: 1,
        messageCount: 0,
      });
      await expectContract(rooms, 'GET', '/admin/rooms');
    });

    it('bans, unbans, kicks and deletes', async () => {
      booted = await boot();
      const admin = await booted.login('admin', 'admin-password');
      const bob = await booted.login('bob', 'bob-builder');
      const bobId = (await booted.api.get('/me', bearer(bob))).body.id;
      const general = (await booted.api.get('/rooms', bearer(bob))).body.rooms[0];

      await expectContract(
        await booted.api.put(`/admin/users/${bobId}/ban`, { ...bearer(admin), expect: 204 }),
        'PUT',
        '/admin/users/{userId}/ban',
      );
      expect(
        (await booted.api.get('/admin/users', bearer(admin))).body.users.find(
          (u: { id: string }) => u.id === bobId,
        ).bannedAt,
      ).toEqual(expect.any(String));
      await expectContract(
        await booted.api.delete(`/admin/users/${bobId}/ban`, { ...bearer(admin), expect: 204 }),
        'DELETE',
        '/admin/users/{userId}/ban',
      );
      await expectContract(
        await booted.api.put('/admin/users/01ARZ3NDEKTSV4RRFFQ69G5FAV/ban', {
          ...bearer(admin),
          expect: 404,
        }),
        'PUT',
        '/admin/users/{userId}/ban',
      );

      await expectContract(
        await booted.api.post(
          `/admin/rooms/${general.id}/kick`,
          { userId: bobId },
          { ...bearer(admin), expect: 204 },
        ),
        'POST',
        '/admin/rooms/{roomId}/kick',
      );
      await expectContract(
        await booted.api.delete(`/admin/rooms/${general.id}`, { ...bearer(admin), expect: 204 }),
        'DELETE',
        '/admin/rooms/{roomId}',
      );
      await expectContract(
        await booted.api.delete(`/admin/rooms/${general.id}`, { ...bearer(admin), expect: 404 }),
        'DELETE',
        '/admin/rooms/{roomId}',
      );
      expect((await booted.api.get('/rooms', bearer(bob))).body.rooms).toEqual([]);
    });

    it('answers unknown paths with the documented error shape', async () => {
      booted = await boot();
      const res = await booted.api.get('/nope', { expect: 404 });
      await expectSchema(res.body, 'Error');
    });
  });
});
