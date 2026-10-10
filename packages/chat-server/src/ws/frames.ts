import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ClientFrame } from '../generated/ws-messages.js';
import { CLIENT_FRAME_SCHEMAS, loadWsSchemas, WS_SCHEMA_ID } from './schemas.js';

const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;

export type ParsedFrame =
  { ok: true; frame: ClientFrame } | { ok: false; id?: string; message: string };

/** Validates inbound frames against the AsyncAPI schemas; compiled once per process. */
export class FrameValidator {
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true });

  constructor() {
    addFormats(this.ajv);
    this.ajv.addSchema(loadWsSchemas());
  }

  parse(raw: string): ParsedFrame {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, message: 'Frame is not valid JSON' };
    }
    const candidate = value as { type?: unknown; id?: unknown } | null;
    const id =
      typeof candidate?.id === 'string' && candidate.id.length > 0 && candidate.id.length <= 64
        ? candidate.id
        : undefined;
    const schemaName =
      typeof candidate?.type === 'string' ? CLIENT_FRAME_SCHEMAS[candidate.type] : undefined;
    if (!schemaName)
      return {
        ok: false,
        ...(id ? { id } : {}),
        message: `Unknown frame type ${JSON.stringify(candidate?.type)}`,
      };
    const validate = this.ajv.getSchema(`${WS_SCHEMA_ID}#/$defs/${schemaName}`)!;
    if (!validate(value))
      return { ok: false, ...(id ? { id } : {}), message: this.ajv.errorsText(validate.errors) };
    return { ok: true, frame: value as ClientFrame };
  }
}
