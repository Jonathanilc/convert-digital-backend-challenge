import { afterAll, describe, expect, it } from 'vitest';
import { expectContract, expectSchema } from '../helpers/contract.js';
import { httpClient } from '../helpers/http.js';
import { connectWs, type WsClient } from '../helpers/ws.js';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3001';
const WS_URL = `${APP_URL.replace(/^http/, 'ws')}/ws`;
const [USERNAME = 'alice', PASSWORD = 'wonderland'] = (
  process.env.SMOKE_USER ?? 'alice:wonderland'
).split(':');

const api = httpClient(APP_URL);

/** A freshly deployed instance may still be connecting to Redis; give it a bounded moment. */
async function waitForHealthy(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api.get('/health', { expect: 200 });
    if (res.body?.status === 'ok' || Date.now() >= deadline) return res;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * Black-box check of a running instance: HTTP contract, both documents, a real login and a real
 * WebSocket round-trip (join the default room, send one message, receive it back). Every received
 * frame is validated against asyncapi.yaml by the client helper.
 */
describe(`chat smoke against ${APP_URL}`, () => {
  const sockets: WsClient[] = [];
  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
  });

  it('is healthy and ready', async () => {
    const health = await waitForHealthy();
    expect(health.body).toMatchObject({ status: 'ok', checks: { redis: 'up', database: 'up' } });
    await expectContract(health, 'GET', '/health');
    await expectContract(await api.get('/ready', { expect: 200 }), 'GET', '/ready');
  });

  it('sends visitors of the bare hostname to the docs', async () => {
    const res = await api.get('/', { expect: 302 });
    expect(res.headers.location).toBe('/docs');
  });

  it('serves both contracts and the docs page', async () => {
    const openapi = await api.get('/openapi.json', { expect: 200 });
    expect(openapi.body.openapi).toBe('3.1.0');
    const asyncapi = await api.get('/asyncapi.yaml', { expect: 200 });
    expect(asyncapi.text).toContain('asyncapi: 3.0.0');
    await expectContract(asyncapi, 'GET', '/asyncapi.yaml');
    await expectContract(await api.get('/docs', { expect: 200 }), 'GET', '/docs');
  });

  it('logs in, joins the default room over a real socket, and exchanges a message', async () => {
    const login = await api.post(
      '/auth/login',
      { username: USERNAME, password: PASSWORD },
      { expect: 200 },
    );
    await expectContract(login, 'POST', '/auth/login');
    const token: string = login.body.token;

    const rooms = await api.get('/rooms', {
      headers: { authorization: `Bearer ${token}` },
      expect: 200,
    });
    await expectContract(rooms, 'GET', '/rooms');
    const general = rooms.body.rooms.find((r: { name: string }) => r.name === 'general');
    expect(general, 'default room exists').toBeDefined();

    const socket = await connectWs(`${WS_URL}?token=${encodeURIComponent(token)}`);
    sockets.push(socket);
    socket.send({ type: 'join', id: 'smoke-join', payload: { roomId: general.id } });
    await socket.next((f) => f.type === 'ack' && f.id === 'smoke-join');
    const snapshot = await socket.next((f) => f.type === 'room.snapshot');
    expect(snapshot.payload.room.id).toBe(general.id);

    const body = `smoke ${new Date().toISOString()}`;
    socket.send({ type: 'send', id: 'smoke-send', payload: { roomId: general.id, body } });
    const ack = await socket.next((f) => f.type === 'ack' && f.id === 'smoke-send');
    const message = await socket.next((f) => f.type === 'message' && f.payload.body === body);
    expect(message.payload.id).toBe(ack.payload.messageId);
    expect(message.payload.user.username).toBe(USERNAME);

    const history = await api.get(`/rooms/${general.id}/messages?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
      expect: 200,
    });
    expect(history.body.messages[0]).toMatchObject({ id: message.payload.id, body });
    await expectContract(history, 'GET', '/rooms/{roomId}/messages');
  });

  it('answers unknown paths with the documented error shape', async () => {
    const res = await api.get('/definitely-not-here', { expect: 404 });
    await expectSchema(res.body, 'Error');
  });
});
