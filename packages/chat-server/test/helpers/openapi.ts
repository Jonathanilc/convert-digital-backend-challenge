import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3_1 } from 'openapi-types';

export const OPENAPI_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));

type Operation = OpenAPIV3_1.OperationObject & {
  responses: Record<string, OpenAPIV3_1.ResponseObject>;
};
type PathItem = Record<string, Operation>;

export interface LoadedDocument {
  openapi: string;
  paths: Record<string, PathItem>;
  components: OpenAPIV3_1.ComponentsObject;
}

/** Loads openapi.yaml with every `$ref` inlined so tests can inspect it structurally. */
export async function loadOpenApiDocument(): Promise<LoadedDocument> {
  const raw = await readFile(OPENAPI_PATH, 'utf8');
  expectNoTabs(raw);
  return (await SwaggerParser.dereference(OPENAPI_PATH)) as unknown as LoadedDocument;
}

function expectNoTabs(yaml: string): void {
  if (yaml.includes('\t')) throw new Error('openapi.yaml must be indented with spaces');
}
