import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
  createChatServer,
  type ChatConfig,
  type ChatServer,
  type ChatServerDeps,
} from '../../src/demo/app.js';
import { SqliteChatRepository } from '../../src/store/sqlite-repository.js';
import { fakeClock, type FakeClock } from '../helpers/clock.js';
import { httpClient, type HttpClient } from '../helpers/http.js';
import { idFactory } from '../helpers/ids.js';
import { connect, deleteByPrefix, testPrefix } from '../helpers/redis.js';
import { connectWs, type WsClient } from '../helpers/ws.js';

export const T0 = 1_700_000_000_000;

export const baseConfig: ChatConfig = {
  jwtSecret: 'test-secret-not-for-production',
  jwtTtlSeconds: 3_600,
  seedUsers: [
    { username: 'admin', password: 'admin-password', role: 'admin' },
    { username: 'alice', password: 'wonderland', role: 'user' },
    { username: 'bob', password: 'bob-builder', role: 'user' },
  ],
  defaultRoom: 'general',
  messageLimit: { limit: 3, windowMs: 10_000 },
  loginLimit: { limit: 20, windowMs: 60_000 },
  trustProxy: false,
  validateResponses: true,
  keyPrefix: 'chat',
  snapshotSize: 50,
};

export interface Booted {
  api: HttpClient;
  baseUrl: string;
  wsUrl: string;
  clock: FakeClock;
  chat: ChatServer;
  repository: SqliteChatRepository;
  /** Logs in through the real HTTP API and returns the JWT. */
  login(username: string, password: string): Promise<string>;
  register(username: string, password: string): Promise<string>;
  /** Opens a real WebSocket authenticated with the token. */
  connect(token: string): Promise<WsClient>;
  close(): Promise<void>;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
    server.once('error', reject);
  });
}

/** The whole chat server on a real port, real SQLite file, real Redis, fake clock. */
export async function boot(
  overrides: Partial<ChatConfig> = {},
  deps: Partial<ChatServerDeps> = {},
): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'chat-'));
  const repository = new SqliteChatRepository(join(dir, 'chat.db'));
  const redis = connect();
  const clock = fakeClock(T0);
  const prefix = testPrefix('chat');
  const chat = await createChatServer({
    config: { ...baseConfig, keyPrefix: prefix, ...overrides },
    redis,
    repository,
    clock: clock.now,
    ids: idFactory(clock.now),
    logger: pino({ level: 'silent' }),
    ...deps,
  });
  const baseUrl = await listen(chat.server);
  const api = httpClient(baseUrl);
  const sockets: WsClient[] = [];

  const auth = async (path: string, username: string, password: string, expect: number) =>
    (await api.post(path, { username, password }, { expect })).body.token as string;

  return {
    api,
    baseUrl,
    wsUrl: `${baseUrl.replace('http', 'ws')}/ws`,
    clock,
    chat,
    repository,
    login: (u, p) => auth('/auth/login', u, p, 200),
    register: (u, p) => auth('/auth/register', u, p, 201),
    connect: async (token) => {
      const client = await connectWs(
        `${baseUrl.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`,
      );
      sockets.push(client);
      return client;
    },
    close: async () => {
      await Promise.all(sockets.map((s) => s.close()));
      await chat.close();
      await deleteByPrefix(redis, prefix);
      await redis.quit();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
