import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** Resolves to `<package>/openapi.yaml` from both `src/demo` and `dist/demo`. */
export const OPENAPI_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));

export type OpenApiDocument = Record<string, unknown> & { openapi: string };

let cached: OpenApiDocument | undefined;

/** The contract as a plain object, parsed once per process. */
export function loadOpenApiDocument(): OpenApiDocument {
  cached ??= parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDocument;
  return cached;
}
