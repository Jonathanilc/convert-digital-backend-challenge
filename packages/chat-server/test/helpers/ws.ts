import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import WebSocket from 'ws';
import { loadWsSchemas, SERVER_FRAME_SCHEMAS, WS_SCHEMA_ID } from '../../src/ws/schemas.js';

const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(loadWsSchemas());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Frame = { type: string; id?: string; payload: any };

/** Throws unless the frame matches the AsyncAPI schema for its type. Every received frame goes through this. */
export function assertServerFrame(frame: unknown): asserts frame is Frame {
  const type = (frame as { type?: unknown })?.type;
  const schemaName = typeof type === 'string' ? SERVER_FRAME_SCHEMAS[type] : undefined;
  if (!schemaName)
    throw new Error(
      `server sent a frame with undocumented type ${JSON.stringify(type)}: ${JSON.stringify(frame)}`,
    );
  const validate = ajv.getSchema(`${WS_SCHEMA_ID}#/$defs/${schemaName}`)!;
  if (!validate(frame))
    throw new Error(
      `frame violates ${schemaName}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(frame)}`,
    );
}

export interface WsClient {
  /** Frames received and not yet consumed by `next`. */
  readonly frames: Frame[];
  send(frame: unknown): void;
  sendRaw(data: string): void;
  /** Resolves with the first (unconsumed) frame matching the filter, waiting up to timeoutMs. */
  next(filter?: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  /** Asserts that no matching frame arrives within the quiet period. */
  expectNone(filter: (frame: Frame) => boolean, quietMs?: number): Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

export class UpgradeRejected extends Error {
  constructor(readonly status: number) {
    super(`WebSocket upgrade rejected with HTTP ${status}`);
  }
}

/** Opens a real WebSocket. Rejects with UpgradeRejected when the server refuses the upgrade. */
export function connectWs(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const frames: Frame[] = [];
    const waiters: Array<{ filter: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
    let settled = false;

    const closed = new Promise<{ code: number; reason: string }>((resolveClosed) => {
      socket.on('close', (code, reason) => resolveClosed({ code, reason: reason.toString() }));
    });

    socket.on('unexpected-response', (_req, res) => {
      settled = true;
      reject(new UpgradeRejected(res.statusCode ?? 0));
      res.resume();
    });
    socket.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as unknown;
      assertServerFrame(frame);
      const index = waiters.findIndex((w) => w.filter(frame));
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
      else frames.push(frame);
    });
    socket.on('open', () => {
      settled = true;
      resolve({
        frames,
        send: (frame) => socket.send(JSON.stringify(frame)),
        sendRaw: (data) => socket.send(data),
        next: (filter = () => true, timeoutMs = 3_000) =>
          new Promise<Frame>((resolveNext, rejectNext) => {
            const index = frames.findIndex(filter);
            if (index >= 0) {
              resolveNext(frames.splice(index, 1)[0]!);
              return;
            }
            const timer = setTimeout(() => {
              const i = waiters.findIndex((w) => w.resolve === done);
              if (i >= 0) waiters.splice(i, 1);
              rejectNext(
                new Error(`timed out waiting for a frame; unconsumed: ${JSON.stringify(frames)}`),
              );
            }, timeoutMs);
            const done = (f: Frame) => {
              clearTimeout(timer);
              resolveNext(f);
            };
            waiters.push({ filter, resolve: done });
          }),
        expectNone: async (filter, quietMs = 150) => {
          await new Promise((r) => setTimeout(r, quietMs));
          const hit = frames.find(filter);
          if (hit) throw new Error(`unexpected frame: ${JSON.stringify(hit)}`);
        },
        closed,
        close: () =>
          new Promise<void>((resolveClose) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolveClose();
              return;
            }
            socket.once('close', () => resolveClose());
            socket.close(1000, 'test done');
          }),
      });
    });
  });
}
