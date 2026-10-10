import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** Resolves to `<package>/asyncapi.yaml` from both `src/ws` and `dist/ws`. */
export const ASYNCAPI_PATH = fileURLToPath(new URL('../../asyncapi.yaml', import.meta.url));

export const WS_SCHEMA_ID = 'chat-ws';

export interface JsonSchemaDocument {
  $id: string;
  $schema: string;
  $defs: Record<string, unknown>;
}

/**
 * The frame schemas live in asyncapi.yaml under components.schemas with AsyncAPI-style
 * `#/components/schemas/...` references. Ajv and the type generator want a plain JSON Schema
 * document, so the references are rewritten to `#/$defs/...`.
 */
export function loadWsSchemas(path = ASYNCAPI_PATH): JsonSchemaDocument {
  const doc = parse(readFileSync(path, 'utf8')) as {
    components?: { schemas?: Record<string, unknown> };
  };
  const schemas = doc.components?.schemas ?? {};
  const rewritten = JSON.parse(
    JSON.stringify(schemas).replaceAll('#/components/schemas/', '#/$defs/'),
  ) as Record<string, unknown>;
  return {
    $id: WS_SCHEMA_ID,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: rewritten,
  };
}

/** Frame types a client may send, keyed by the `type` discriminator. */
export const CLIENT_FRAME_SCHEMAS: Record<string, string> = {
  join: 'JoinFrame',
  leave: 'LeaveFrame',
  send: 'SendFrame',
  edit: 'EditFrame',
  delete: 'DeleteFrame',
};

/** Frame types the server emits, keyed by the `type` discriminator. */
export const SERVER_FRAME_SCHEMAS: Record<string, string> = {
  ack: 'AckFrame',
  error: 'ErrorFrame',
  joined: 'JoinedFrame',
  left: 'LeftFrame',
  'room.snapshot': 'RoomSnapshotFrame',
  message: 'MessageFrame',
  'message.edited': 'MessageEditedFrame',
  'message.deleted': 'MessageDeletedFrame',
  mention: 'MentionFrame',
};
