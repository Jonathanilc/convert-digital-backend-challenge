import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer } from 'ws';
import { ChatError } from '../core/errors.js';
import type { ChatEvent, ChatService } from '../core/service.js';
import type { User, UserRecord } from '../core/types.js';
import type { ServerFrame } from '../generated/ws-messages.js';
import { authenticateToken, bearerFromHeader, type TokenOptions } from '../http/auth.js';
import { toRoomView } from '../http/routes.js';
import type { ChatRepository } from '../store/repository.js';
import { FrameValidator } from './frames.js';

export interface ChatSocketDeps {
  service: ChatService;
  repository: ChatRepository;
  tokens: TokenOptions;
  logger: Logger;
  path?: string;
}

/** Close code sent to a user whose account was banned while connected. */
export const CLOSE_BANNED = 4403;

/**
 * Attaches the WebSocket endpoint to an existing HTTP server. Authentication happens on the
 * upgrade; afterwards every frame is validated against the contract and dispatched to the
 * ChatService, whose events are fanned out to the sockets of the affected room's members.
 */
export function attachChatSocket(server: Server, deps: ChatSocketDeps): { close(): Promise<void> } {
  const { service, repository, tokens, logger } = deps;
  const path = deps.path ?? '/ws';
  const wss = new WebSocketServer({ noServer: true });
  const validator = new FrameValidator();
  const socketsByUser = new Map<string, Set<WebSocket>>();

  const send = (ws: WebSocket, frame: ServerFrame): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const sendToUsers = (userIds: Iterable<string>, frame: ServerFrame): void => {
    for (const id of userIds) for (const ws of socketsByUser.get(id) ?? []) send(ws, frame);
  };
  const memberIds = async (roomId: string): Promise<string[]> =>
    (await repository.listMembers(roomId)).map((u) => u.id);

  // ---- upgrade: authenticate before a socket exists ----
  const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') ?? bearerFromHeader(req.headers.authorization);
    const result = await authenticateToken(token || undefined, repository, tokens);
    if (!result || 'error' in result) {
      const status = result && 'error' in result ? result.error.status : 401;
      socket.write(
        `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, result.user));
  };
  server.on('upgrade', (req, socket, head) => {
    onUpgrade(req, socket, head).catch((error: unknown) => {
      logger.error({ err: error }, 'websocket upgrade failed');
      socket.destroy();
    });
  });

  // ---- per connection ----
  const onConnection = (ws: WebSocket, user: UserRecord): void => {
    let set = socketsByUser.get(user.id);
    if (!set) socketsByUser.set(user.id, (set = new Set()));
    set.add(ws);
    ws.on('close', () => {
      set.delete(ws);
      if (set.size === 0) socketsByUser.delete(user.id);
    });
    ws.on('message', (data) => {
      handle(ws, user, data.toString()).catch((error: unknown) => {
        logger.error({ err: error, userId: user.id }, 'frame handling failed');
        send(ws, { type: 'error', payload: { code: 'internal', message: 'Internal error' } });
      });
    });
  };

  const handle = async (ws: WebSocket, user: UserRecord, raw: string): Promise<void> => {
    const parsed = validator.parse(raw);
    if (!parsed.ok) {
      send(ws, {
        type: 'error',
        ...(parsed.id ? { id: parsed.id } : {}),
        payload: { code: 'invalid_frame', message: parsed.message },
      });
      return;
    }
    const { frame } = parsed;
    const ack = (payload: { messageId?: string } = {}): void => {
      if (frame.id) send(ws, { type: 'ack', id: frame.id, payload });
    };
    try {
      switch (frame.type) {
        case 'join': {
          const snapshot = await service.joinRoom(user, frame.payload.roomId);
          ack();
          send(ws, {
            type: 'room.snapshot',
            payload: {
              room: toRoomView(snapshot.room),
              members: snapshot.members,
              messages: snapshot.messages,
            },
          });
          break;
        }
        case 'leave':
          await service.leaveRoom(user, frame.payload.roomId);
          ack();
          break;
        case 'send': {
          const message = await service.sendMessage(user, frame.payload.roomId, frame.payload.body);
          ack({ messageId: message.id });
          break;
        }
        case 'edit':
          await service.editMessage(user, frame.payload.messageId, frame.payload.body);
          ack();
          break;
        case 'delete':
          await service.deleteMessage(user, frame.payload.messageId);
          ack();
          break;
      }
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      send(ws, {
        type: 'error',
        ...(frame.id ? { id: frame.id } : {}),
        payload: {
          code:
            error.code === 'conflict' || error.code === 'validation' ? 'invalid_frame' : error.code,
          message: error.message,
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        },
      });
    }
  };

  // ---- fan-out of domain events ----
  const onEvent = async (event: ChatEvent): Promise<void> => {
    switch (event.type) {
      case 'room.joined':
        sendToUsers(await memberIds(event.roomId), {
          type: 'joined',
          payload: { roomId: event.roomId, user: event.user },
        });
        break;
      case 'room.left':
        sendToUsers([...(await memberIds(event.roomId)), event.user.id], {
          type: 'left',
          payload: { roomId: event.roomId, user: event.user },
        });
        break;
      case 'message.created':
        sendToUsers(await memberIds(event.roomId), { type: 'message', payload: event.message });
        sendToUsers(event.mentionedUserIds, {
          type: 'mention',
          payload: { message: event.message },
        });
        break;
      case 'message.edited':
        sendToUsers(await memberIds(event.roomId), {
          type: 'message.edited',
          payload: {
            id: event.id,
            roomId: event.roomId,
            body: event.body,
            editedAt: event.editedAt,
          },
        });
        break;
      case 'message.deleted':
        sendToUsers(await memberIds(event.roomId), {
          type: 'message.deleted',
          payload: { id: event.id, roomId: event.roomId },
        });
        break;
      case 'member.kicked':
        sendToUsers([...(await memberIds(event.roomId)), event.user.id], {
          type: 'left',
          payload: { roomId: event.roomId, user: event.user },
        });
        break;
      case 'room.deleted':
        for (const member of event.members as User[])
          sendToUsers([member.id], {
            type: 'left',
            payload: { roomId: event.roomId, user: member },
          });
        break;
      case 'user.banned':
        for (const ws of socketsByUser.get(event.userId) ?? []) ws.close(CLOSE_BANNED, 'banned');
        break;
    }
  };
  const listener = (event: ChatEvent): void => {
    onEvent(event).catch((error: unknown) =>
      logger.error({ err: error, event: event.type }, 'event fan-out failed'),
    );
  };
  service.events.on('event', listener);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        service.events.off('event', listener);
        for (const ws of wss.clients) ws.terminate();
        for (const set of socketsByUser.values()) for (const ws of set) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}
