export {
  ChatService,
  type ChatEvent,
  type ChatServiceDeps,
  type HistoryPage,
  type RoomSnapshot,
} from './core/service.js';
export { ChatError, HTTP_STATUS_BY_CODE, type ChatErrorCode } from './core/errors.js';
export { canJoinRoom, canManageRoom, canModifyMessage, isAdmin } from './core/authorization.js';
export { extractMentionUsernames } from './core/mentions.js';
export { toMessageView, toUserView, type MessageView } from './core/views.js';
export { UniqueConstraintError } from './core/types.js';
export type { MessageRecord, Role, Room, User, UserRecord, Visibility } from './core/types.js';
export type {
  ChatRepository,
  CreateRoomInput,
  CreateUserInput,
  ListMessagesOptions,
  RoomWithCounts,
} from './store/repository.js';
export { SqliteChatRepository } from './store/sqlite-repository.js';
export { attachChatSocket, CLOSE_BANNED } from './ws/server.js';
export { FrameValidator } from './ws/frames.js';
export { loadWsSchemas, CLIENT_FRAME_SCHEMAS, SERVER_FRAME_SCHEMAS } from './ws/schemas.js';
export {
  createChatServer,
  type ChatConfig,
  type ChatServer,
  type ChatServerDeps,
  type SeedUser,
} from './demo/app.js';
export { loadConfig, type ServerConfig } from './demo/config.js';
