import type { Redis } from 'ioredis';
import { Router, type RequestHandler } from 'express';
import type { ChatService } from '../core/service.js';
import type { Room, UserRecord } from '../core/types.js';
import { toUserView } from '../core/views.js';
import type { components } from '../generated/openapi.js';
import type { ChatRepository } from '../store/repository.js';
import {
  hashPassword,
  issueToken,
  requireAdmin,
  verifyPassword,
  type TokenOptions,
} from './auth.js';
import { docsPage } from './docs.js';
import { sendError } from './errors.js';

type Schemas = components['schemas'];

export interface RoutesContext {
  service: ChatService;
  repository: ChatRepository;
  redis: Redis;
  tokens: TokenOptions;
  openapi: Record<string, unknown> & { info?: { title?: string } };
  asyncapiYaml: string;
  defaultRoom: string;
}

export const toRoomView = (r: Room): Schemas['Room'] => ({
  id: r.id,
  name: r.name,
  visibility: r.visibility,
  ownerId: r.ownerId,
});

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const toAdminUser = (u: UserRecord): Schemas['AdminUser'] => ({
  id: u.id,
  username: u.username,
  role: u.role,
  bannedAt: iso(u.bannedAt),
  createdAt: new Date(u.createdAt).toISOString(),
});

export function createRoutes(ctx: RoutesContext): Router {
  const { service, repository, redis, tokens } = ctx;
  const router = Router();
  const user = (req: Parameters<RequestHandler>[0]): UserRecord => req.user as UserRecord;

  // ---- meta ----
  const checks = async (): Promise<Schemas['Health']['checks']> => {
    const [redisUp, dbUp] = await Promise.all([
      redis.ping().then(
        () => true,
        () => false,
      ),
      repository.findRoomByName(ctx.defaultRoom).then(
        () => true,
        () => false,
      ),
    ]);
    return { redis: redisUp ? 'up' : 'down', database: dbUp ? 'up' : 'down' };
  };
  router.get('/', (_req, res) => {
    res.status(302).set('Location', '/docs').end(); // no body, as documented
  });
  router.get('/health', async (_req, res) => {
    const c = await checks();
    const body: Schemas['Health'] = {
      status: c.redis === 'up' && c.database === 'up' ? 'ok' : 'degraded',
      checks: c,
    };
    res.json(body);
  });
  router.get('/ready', async (_req, res) => {
    const c = await checks();
    const ready = c.database === 'up'; // Redis down only degrades the message limiter (fail-open)
    const body: Schemas['Readiness'] = { status: ready ? 'ready' : 'not-ready', checks: c };
    res.status(ready ? 200 : 503).json(body);
  });
  const docs = docsPage(ctx.openapi.info?.title ?? 'API');
  router.get('/docs', (_req, res) => {
    res.type('html').send(docs);
  });
  router.get('/openapi.json', (_req, res) => {
    res.json(ctx.openapi);
  });
  router.get('/asyncapi.yaml', (_req, res) => {
    res.type('application/yaml').send(ctx.asyncapiYaml);
  });

  // ---- accounts ----
  router.post('/auth/register', async (req, res) => {
    const { username, password } = req.body as Schemas['Credentials'];
    const created = await service.createUser({
      username,
      passwordHash: await hashPassword(password),
      role: 'user',
    });
    const body: Schemas['AuthResponse'] = {
      token: await issueToken(created, tokens),
      user: toUserView(created),
    };
    res.status(201).json(body);
  });
  router.post('/auth/login', async (req, res) => {
    const { username, password } = req.body as Schemas['Credentials'];
    const found = await repository.findUserByUsername(username);
    if (!found || !(await verifyPassword(password, found.passwordHash))) {
      sendError(res, 401, 'Invalid username or password');
      return;
    }
    if (found.bannedAt !== null) {
      sendError(res, 403, 'This account is banned');
      return;
    }
    const body: Schemas['AuthResponse'] = {
      token: await issueToken(found, tokens),
      user: toUserView(found),
    };
    res.json(body);
  });
  router.get('/me', (req, res) => {
    res.json(toUserView(user(req)));
  });

  // ---- rooms ----
  router.get('/rooms', async (req, res) => {
    const body: Schemas['RoomList'] = {
      rooms: (await service.listRooms(user(req))).map(toRoomView),
    };
    res.json(body);
  });
  router.post('/rooms', async (req, res) => {
    const { name, visibility = 'public' } = req.body as Schemas['CreateRoomRequest'];
    res.status(201).json(toRoomView(await service.createRoom(user(req), { name, visibility })));
  });
  router.get('/rooms/:roomId', async (req, res) => {
    const { room, members } = await service.getRoom(user(req), String(req.params.roomId));
    const body: Schemas['RoomDetails'] = { room: toRoomView(room), members };
    res.json(body);
  });
  router.post('/rooms/:roomId/members', async (req, res) => {
    await service.addMember(
      user(req),
      String(req.params.roomId),
      (req.body as Schemas['AddMemberRequest']).userId,
    );
    res.status(204).end();
  });

  // ---- history ----
  router.get('/rooms/:roomId/messages', async (req, res) => {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const page = await service.getHistory(user(req), String(req.params.roomId), {
      limit,
      ...(before ? { before } : {}),
    });
    const body: Schemas['MessagePage'] = page;
    res.json(body);
  });

  // ---- admin ----
  const admin = Router();
  admin.use(requireAdmin);
  admin.get('/users', async (req, res) => {
    const body: Schemas['UserList'] = {
      users: (await service.listUsers(user(req))).map(toAdminUser),
    };
    res.json(body);
  });
  admin.put('/users/:userId/ban', async (req, res) => {
    await service.banUser(user(req), String(req.params.userId));
    res.status(204).end();
  });
  admin.delete('/users/:userId/ban', async (req, res) => {
    await service.unbanUser(user(req), String(req.params.userId));
    res.status(204).end();
  });
  admin.get('/rooms', async (req, res) => {
    const rooms = await service.listRoomsWithCounts(user(req));
    const body: Schemas['AdminRoomList'] = {
      rooms: rooms.map((r) => ({
        room: toRoomView(r.room),
        memberCount: r.memberCount,
        messageCount: r.messageCount,
      })),
    };
    res.json(body);
  });
  admin.delete('/rooms/:roomId', async (req, res) => {
    await service.deleteRoom(user(req), String(req.params.roomId));
    res.status(204).end();
  });
  admin.post('/rooms/:roomId/kick', async (req, res) => {
    await service.kickUser(
      user(req),
      String(req.params.roomId),
      (req.body as Schemas['KickRequest']).userId,
    );
    res.status(204).end();
  });
  router.use('/admin', admin);

  return router;
}
