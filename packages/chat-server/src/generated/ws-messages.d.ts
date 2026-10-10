/* eslint-disable */
/** Generated from asyncapi.yaml by scripts/asyncapi-types.ts. Do not edit. */

/**
 * Time-sortable identifier (ULID).
 */
export type Ulid = string;
/**
 * Client-chosen id, echoed in the matching ack or error.
 */
export type CorrelationId = string;
export type Username = string;
/**
 * Message text. Mentions are written as `@username`.
 */
export type Body = string;
export type DateTime = string;
export type ClientFrame = JoinFrame | LeaveFrame | SendFrame | EditFrame | DeleteFrame;
export type ServerFrame =
  | AckFrame
  | ErrorFrame
  | JoinedFrame
  | LeftFrame
  | RoomSnapshotFrame
  | MessageFrame
  | MessageEditedFrame
  | MessageDeletedFrame
  | MentionFrame;

export interface ChatWs {
  Ulid: Ulid;
  CorrelationId: CorrelationId;
  Username: Username;
  Body: Body;
  DateTime: DateTime;
  User: User;
  Room: Room;
  Message: Message;
  JoinFrame: JoinFrame;
  LeaveFrame: LeaveFrame;
  SendFrame: SendFrame;
  EditFrame: EditFrame;
  DeleteFrame: DeleteFrame;
  ClientFrame: ClientFrame;
  AckFrame: AckFrame;
  ErrorFrame: ErrorFrame;
  JoinedFrame: JoinedFrame;
  LeftFrame: LeftFrame;
  RoomSnapshotFrame: RoomSnapshotFrame;
  MessageFrame: MessageFrame;
  MessageEditedFrame: MessageEditedFrame;
  MessageDeletedFrame: MessageDeletedFrame;
  MentionFrame: MentionFrame;
  ServerFrame: ServerFrame;
}
export interface User {
  id: Ulid;
  username: Username;
  role: 'user' | 'admin';
}
export interface Room {
  id: Ulid;
  name: string;
  visibility: 'public' | 'private';
  ownerId: Ulid;
}
export interface Message {
  id: Ulid;
  roomId: Ulid;
  user: User;
  /**
   * Empty string when deleted.
   */
  body: string;
  mentions: User[];
  createdAt: DateTime;
  editedAt: DateTime | null;
  deletedAt: DateTime | null;
}
export interface JoinFrame {
  type: 'join';
  id?: CorrelationId;
  payload: {
    roomId: Ulid;
  };
}
export interface LeaveFrame {
  type: 'leave';
  id?: CorrelationId;
  payload: {
    roomId: Ulid;
  };
}
export interface SendFrame {
  type: 'send';
  id?: CorrelationId;
  payload: {
    roomId: Ulid;
    body: Body;
  };
}
export interface EditFrame {
  type: 'edit';
  id?: CorrelationId;
  payload: {
    messageId: Ulid;
    body: Body;
  };
}
export interface DeleteFrame {
  type: 'delete';
  id?: CorrelationId;
  payload: {
    messageId: Ulid;
  };
}
export interface AckFrame {
  type: 'ack';
  id: CorrelationId;
  payload: {
    /**
     * Time-sortable identifier (ULID).
     */
    messageId?: string;
  };
}
export interface ErrorFrame {
  type: 'error';
  id?: CorrelationId;
  payload: {
    code:
      | 'invalid_frame'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'not_joined'
      | 'rate_limited'
      | 'banned'
      | 'internal';
    message: string;
    retryAfterMs?: number;
  };
}
export interface JoinedFrame {
  type: 'joined';
  payload: {
    roomId: Ulid;
    user: User;
  };
}
export interface LeftFrame {
  type: 'left';
  payload: {
    roomId: Ulid;
    user: User;
  };
}
export interface RoomSnapshotFrame {
  type: 'room.snapshot';
  payload: {
    room: Room;
    members: User[];
    /**
     * Most recent messages, oldest first.
     */
    messages: Message[];
  };
}
export interface MessageFrame {
  type: 'message';
  payload: Message;
}
export interface MessageEditedFrame {
  type: 'message.edited';
  payload: {
    id: Ulid;
    roomId: Ulid;
    body: Body;
    editedAt: DateTime;
  };
}
export interface MessageDeletedFrame {
  type: 'message.deleted';
  payload: {
    id: Ulid;
    roomId: Ulid;
  };
}
export interface MentionFrame {
  type: 'mention';
  payload: {
    message: Message;
  };
}
