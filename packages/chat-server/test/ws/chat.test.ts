import { afterEach, describe, expect, it } from 'vitest';
import { boot, type Booted } from '../helpers/boot.js';
import { UpgradeRejected, type Frame, type WsClient } from '../helpers/ws.js';

const ofType = (type: string, id?: string) => (f: Frame) =>
  f.type === type && (id === undefined || f.id === id);

describe('WebSocket chat (real sockets, real Redis, real SQLite)', () => {
  let booted: Booted;
  afterEach(async () => {
    await booted?.close();
  });

  /** Logs in alice and bob, joins both to the default room, and returns ready clients. */
  async function twoInGeneral() {
    booted = await boot();
    const [aliceToken, bobToken] = await Promise.all([
      booted.login('alice', 'wonderland'),
      booted.login('bob', 'bob-builder'),
    ]);
    const general = (
      await booted.api.get('/rooms', {
        headers: { authorization: `Bearer ${aliceToken}` },
        expect: 200,
      })
    ).body.rooms.find((r: { name: string }) => r.name === 'general');
    const alice = await booted.connect(aliceToken);
    const bob = await booted.connect(bobToken);
    await join(alice, general.id);
    await join(bob, general.id);
    // drain join noise so each test starts from silence
    await alice.next(ofType('joined'));
    alice.frames.length = 0;
    bob.frames.length = 0;
    return { alice, bob, general, aliceToken, bobToken };
  }

  async function join(client: WsClient, roomId: string, id = `join-${roomId}`) {
    client.send({ type: 'join', id, payload: { roomId } });
    const ack = await client.next(ofType('ack', id));
    const snapshot = await client.next(ofType('room.snapshot'));
    return { ack, snapshot };
  }

  describe('connection', () => {
    it('refuses the upgrade without a valid token', async () => {
      booted = await boot();
      await expect(booted.connect('not-a-jwt')).rejects.toBeInstanceOf(UpgradeRejected);
      await expect(booted.connect('not-a-jwt')).rejects.toMatchObject({ status: 401 });
      await expect(booted.connect('')).rejects.toMatchObject({ status: 401 });
    });

    it('accepts the token as a bearer header too', async () => {
      booted = await boot();
      const token = await booted.login('alice', 'wonderland');
      const { connectWs } = await import('../helpers/ws.js');
      const client = await connectWs(booted.wsUrl, { authorization: `Bearer ${token}` });
      client.send({ type: 'leave', id: 'x', payload: { roomId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } });
      await expect(client.next(ofType('ack', 'x'))).resolves.toBeDefined();
      await client.close();
    });

    it('answers malformed frames with invalid_frame and keeps the connection open', async () => {
      booted = await boot();
      const client = await booted.connect(await booted.login('alice', 'wonderland'));

      client.sendRaw('this is not json');
      expect((await client.next(ofType('error'))).payload.code).toBe('invalid_frame');

      client.send({ type: 'teleport', id: 't1', payload: {} });
      expect(await client.next(ofType('error', 't1'))).toMatchObject({
        payload: { code: 'invalid_frame' },
      });

      client.send({ type: 'send', id: 's1', payload: { roomId: 'not-a-ulid', body: '' } });
      expect(await client.next(ofType('error', 's1'))).toMatchObject({
        payload: { code: 'invalid_frame' },
      });

      client.send({ type: 'leave', id: 'ok', payload: { roomId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } });
      await expect(client.next(ofType('ack', 'ok'))).resolves.toBeDefined(); // still alive
    });
  });

  describe('rooms', () => {
    it('joins with an ack, a snapshot for the joiner and a joined broadcast for the room', async () => {
      booted = await boot();
      const aliceToken = await booted.login('alice', 'wonderland');
      const general = (
        await booted.api.get('/rooms', { headers: { authorization: `Bearer ${aliceToken}` } })
      ).body.rooms[0];
      const alice = await booted.connect(aliceToken);
      const bob = await booted.connect(await booted.login('bob', 'bob-builder'));

      const { snapshot } = await join(alice, general.id);
      expect(snapshot.payload.room).toMatchObject({ name: 'general', visibility: 'public' });
      expect(snapshot.payload.members.map((m: { username: string }) => m.username)).toEqual([
        'admin',
        'alice',
      ]);
      expect(snapshot.payload.messages).toEqual([]);

      await alice.next(ofType('joined')); // alice's own join broadcast
      await join(bob, general.id);
      const joined = await alice.next(ofType('joined'));
      expect(joined.payload).toMatchObject({
        roomId: general.id,
        user: { username: 'bob', role: 'user' },
      });
    });

    it('rejects joining a private room without membership, with a correlated error', async () => {
      booted = await boot();
      const aliceToken = await booted.login('alice', 'wonderland');
      const secret = (
        await booted.api.post(
          '/rooms',
          { name: 'secret', visibility: 'private' },
          { headers: { authorization: `Bearer ${aliceToken}` }, expect: 201 },
        )
      ).body;
      const bob = await booted.connect(await booted.login('bob', 'bob-builder'));

      bob.send({ type: 'join', id: 'j9', payload: { roomId: secret.id } });
      expect(await bob.next(ofType('error', 'j9'))).toMatchObject({
        payload: { code: 'forbidden' },
      });
      bob.send({ type: 'join', id: 'j10', payload: { roomId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } });
      expect(await bob.next(ofType('error', 'j10'))).toMatchObject({
        payload: { code: 'not_found' },
      });
    });

    it('broadcasts left when a member leaves', async () => {
      const { alice, bob, general } = await twoInGeneral();
      bob.send({ type: 'leave', id: 'l1', payload: { roomId: general.id } });
      await bob.next(ofType('ack', 'l1'));
      expect((await alice.next(ofType('left'))).payload).toMatchObject({
        roomId: general.id,
        user: { username: 'bob' },
      });
    });
  });

  describe('messages', () => {
    it('fans a message out to every member including the sender, with an ack carrying the id', async () => {
      const { alice, bob, general } = await twoInGeneral();
      alice.send({ type: 'send', id: 'm1', payload: { roomId: general.id, body: 'hello room' } });

      const ack = await alice.next(ofType('ack', 'm1'));
      const seenByAlice = await alice.next(ofType('message'));
      const seenByBob = await bob.next(ofType('message'));
      expect(ack.payload.messageId).toBe(seenByAlice.payload.id);
      expect(seenByBob).toEqual(seenByAlice);
      expect(seenByBob.payload).toMatchObject({
        roomId: general.id,
        body: 'hello room',
        user: { username: 'alice' },
        mentions: [],
      });
    });

    it('does not deliver to users who are not members of the room', async () => {
      const { alice, general, bobToken } = await twoInGeneral();
      const carolToken = await booted.register('carol', 'carol-password');
      const carol = await booted.connect(carolToken);
      const other = (
        await booted.api.post(
          '/rooms',
          { name: 'other' },
          { headers: { authorization: `Bearer ${bobToken}` }, expect: 201 },
        )
      ).body;
      await join(carol, other.id);

      alice.send({ type: 'send', id: 'm2', payload: { roomId: general.id, body: 'members only' } });
      await alice.next(ofType('ack', 'm2'));
      await carol.expectNone(ofType('message'));
    });

    it('requires membership to send', async () => {
      booted = await boot();
      const aliceToken = await booted.login('alice', 'wonderland');
      const general = (
        await booted.api.get('/rooms', { headers: { authorization: `Bearer ${aliceToken}` } })
      ).body.rooms[0];
      const bob = await booted.connect(await booted.login('bob', 'bob-builder'));
      bob.send({ type: 'send', id: 'nope', payload: { roomId: general.id, body: 'hi' } });
      expect(await bob.next(ofType('error', 'nope'))).toMatchObject({
        payload: { code: 'not_joined' },
      });
    });

    it('delivers mentions to the mentioned user on their own socket, wherever they are', async () => {
      const { alice, general, bobToken } = await twoInGeneral();
      const carolToken = await booted.register('carol', 'carol-password');
      const carol = await booted.connect(carolToken);
      const other = (
        await booted.api.post(
          '/rooms',
          { name: 'other' },
          { headers: { authorization: `Bearer ${bobToken}` }, expect: 201 },
        )
      ).body;
      await join(carol, other.id);

      alice.send({
        type: 'send',
        id: 'm3',
        payload: { roomId: general.id, body: 'ping @carol and @nobody' },
      });
      await alice.next(ofType('ack', 'm3'));
      const mention = await carol.next(ofType('mention'));
      expect(mention.payload.message).toMatchObject({
        body: 'ping @carol and @nobody',
        mentions: [{ username: 'carol' }],
      });
      await carol.expectNone(ofType('message'));
    });

    it('rate limits sends per user and tells the client when to retry', async () => {
      const { alice, bob, general } = await twoInGeneral();
      for (let i = 0; i < 3; i++) {
        alice.send({ type: 'send', id: `r${i}`, payload: { roomId: general.id, body: `m${i}` } });
        await alice.next(ofType('ack', `r${i}`));
      }
      alice.send({ type: 'send', id: 'r3', payload: { roomId: general.id, body: 'too fast' } });
      const error = await alice.next(ofType('error', 'r3'));
      expect(error.payload).toMatchObject({ code: 'rate_limited', retryAfterMs: 10_000 });
      await bob.expectNone((f) => f.type === 'message' && f.payload.body === 'too fast');

      booted.clock.advance(10_000);
      alice.send({ type: 'send', id: 'r4', payload: { roomId: general.id, body: 'ok now' } });
      await expect(alice.next(ofType('ack', 'r4'))).resolves.toBeDefined();
    });

    it('broadcasts edits and deletions, and enforces authorship', async () => {
      const { alice, bob, general } = await twoInGeneral();
      alice.send({ type: 'send', id: 'e0', payload: { roomId: general.id, body: 'tpyo' } });
      const {
        payload: { messageId },
      } = await alice.next(ofType('ack', 'e0'));
      await bob.next(ofType('message'));

      bob.send({ type: 'edit', id: 'e1', payload: { messageId, body: 'hijack' } });
      expect(await bob.next(ofType('error', 'e1'))).toMatchObject({
        payload: { code: 'forbidden' },
      });

      alice.send({ type: 'edit', id: 'e2', payload: { messageId, body: 'typo' } });
      await alice.next(ofType('ack', 'e2'));
      expect((await bob.next(ofType('message.edited'))).payload).toMatchObject({
        id: messageId,
        roomId: general.id,
        body: 'typo',
      });

      alice.send({ type: 'delete', id: 'd1', payload: { messageId } });
      await alice.next(ofType('ack', 'd1'));
      expect((await bob.next(ofType('message.deleted'))).payload).toEqual({
        id: messageId,
        roomId: general.id,
      });

      alice.send({ type: 'delete', id: 'd2', payload: { messageId } });
      expect(await alice.next(ofType('error', 'd2'))).toMatchObject({
        payload: { code: 'not_found' },
      });
    });

    it('keeps delivering to a member who reconnects, without re-joining', async () => {
      const { alice, bob, general, bobToken } = await twoInGeneral();
      await bob.close();
      const bobAgain = await booted.connect(bobToken);
      alice.send({ type: 'send', id: 'rc', payload: { roomId: general.id, body: 'still here?' } });
      await alice.next(ofType('ack', 'rc'));
      expect((await bobAgain.next(ofType('message'))).payload.body).toBe('still here?');
    });
  });

  describe('administration reaches connected clients', () => {
    it('kicking a user sends left to the room and stops their delivery', async () => {
      const { alice, bob, general } = await twoInGeneral();
      const adminToken = await booted.login('admin', 'admin-password');
      const bobId = (
        await booted.api.get('/me', {
          headers: { authorization: `Bearer ${await booted.login('bob', 'bob-builder')}` },
        })
      ).body.id;

      await booted.api.post(
        `/admin/rooms/${general.id}/kick`,
        { userId: bobId },
        { headers: { authorization: `Bearer ${adminToken}` }, expect: 204 },
      );
      expect((await alice.next(ofType('left'))).payload).toMatchObject({
        roomId: general.id,
        user: { username: 'bob' },
      });
      expect((await bob.next(ofType('left'))).payload).toMatchObject({
        roomId: general.id,
        user: { username: 'bob' },
      });

      alice.send({ type: 'send', id: 'k1', payload: { roomId: general.id, body: 'bob gone?' } });
      await alice.next(ofType('ack', 'k1'));
      await bob.expectNone(ofType('message'));
    });

    it('banning a user closes their sockets', async () => {
      const { bob } = await twoInGeneral();
      const adminToken = await booted.login('admin', 'admin-password');
      const bobId = (
        await booted.api.get('/me', {
          headers: { authorization: `Bearer ${await booted.login('bob', 'bob-builder')}` },
        })
      ).body.id;

      await booted.api.put(`/admin/users/${bobId}/ban`, {
        headers: { authorization: `Bearer ${adminToken}` },
        expect: 204,
      });
      expect(await bob.closed).toMatchObject({ code: 4403 });
      await expect(
        booted.connect(await booted.login('alice', 'wonderland')),
      ).resolves.toBeDefined();
    });

    it('deleting a room tells every connected member they left', async () => {
      const { alice, bob, general } = await twoInGeneral();
      const adminToken = await booted.login('admin', 'admin-password');
      await booted.api.delete(`/admin/rooms/${general.id}`, {
        headers: { authorization: `Bearer ${adminToken}` },
        expect: 204,
      });
      expect((await alice.next(ofType('left'))).payload).toMatchObject({
        roomId: general.id,
        user: { username: 'alice' },
      });
      expect((await bob.next(ofType('left'))).payload).toMatchObject({
        roomId: general.id,
        user: { username: 'bob' },
      });
    });
  });
});
