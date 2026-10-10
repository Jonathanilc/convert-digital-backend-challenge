import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export interface HttpResponse {
  status: number;
  /** Lower-cased header names, as the Fetch API exposes them. */
  headers: Record<string, string>;
  /** Parsed JSON body when the response is JSON, otherwise undefined. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  json?: unknown;
  /** Assert this status; the failure message includes the response body. */
  expect?: number;
}

export interface HttpClient {
  request(method: string, path: string, options?: RequestOptions): Promise<HttpResponse>;
  get(path: string, options?: RequestOptions): Promise<HttpResponse>;
  post(path: string, json?: unknown, options?: RequestOptions): Promise<HttpResponse>;
  put(path: string, options?: RequestOptions): Promise<HttpResponse>;
  delete(path: string, options?: RequestOptions): Promise<HttpResponse>;
}

/** Thin client over the global `fetch`: real sockets, real HTTP parsing, no framework shims. */
export function httpClient(baseUrl: string): HttpClient {
  const request = async (
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse> => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    }

    const res = await fetch(new URL(path, baseUrl), { method, headers, body, redirect: 'manual' });
    const text = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    const response: HttpResponse = {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: isJson && text.length > 0 ? JSON.parse(text) : undefined,
      text,
    };

    if (options.expect !== undefined && res.status !== options.expect) {
      throw new Error(`${method} ${path}: expected ${options.expect}, got ${res.status}\n${text}`);
    }
    return response;
  };

  return {
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, json, options) => request('POST', path, { ...options, json }),
    put: (path, options) => request('PUT', path, options),
    delete: (path, options) => request('DELETE', path, options),
  };
}

export interface RunningServer {
  baseUrl: string;
  server: Server;
  api: HttpClient;
  close(): Promise<void>;
}

/** Serves an Express app on an ephemeral loopback port so tests go through a real listener. */
export async function startServer(app: Express): Promise<RunningServer> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    server,
    api: httpClient(baseUrl),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); // drop keep-alive sockets held by fetch
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
