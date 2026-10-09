import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv-formats is CommonJS with `module.exports = plugin`; under NodeNext the default import is
// typed as the namespace while the runtime value is the plugin function itself.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;
import type { HttpResponse } from './http.js';
import { expect } from 'vitest';
import { loadOpenApiDocument, type LoadedDocument } from './openapi.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

let documentPromise: Promise<LoadedDocument> | undefined;
const document = () => (documentPromise ??= loadOpenApiDocument());

type Schema = Record<string, unknown> & { type?: string };

function validate(schema: Schema, value: unknown, label: string): void {
  const fn = ajv.compile(schema);
  const ok = fn(value);
  expect(
    ok,
    `${label} violates the contract: ${ajv.errorsText(fn.errors)}\n${JSON.stringify(value)}`,
  ).toBe(true);
}

/**
 * Asserts that a response matches what openapi.yaml documents for `method path`:
 * the status is documented, every documented header is present and well-formed, and the
 * body validates against the documented JSON schema (or is empty when none is documented).
 */
export async function expectContract(
  res: HttpResponse,
  method: string,
  path: string,
): Promise<void> {
  const doc = await document();
  const operation = doc.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is documented`).toBeDefined();

  const response = operation!.responses[String(res.status)];
  expect(response, `${method} ${path} documents status ${res.status}`).toBeDefined();

  for (const [name, header] of Object.entries(response!.headers ?? {})) {
    const value = res.headers[name.toLowerCase()];
    expect(value, `${method} ${path} ${res.status} must send ${name}`).toBeDefined();
    const schema = (header as { schema?: Schema }).schema;
    if (schema)
      validate(schema, schema.type === 'integer' ? Number(value) : value, `${name} header`);
  }

  const content = response!.content ?? {};
  const schema = (content['application/json'] as { schema?: Schema } | undefined)?.schema;
  if (schema) {
    validate(schema, res.body, `${method} ${path} ${res.status} body`);
  } else if (Object.keys(content).length > 0) {
    // Documented non-JSON response (e.g. text/html): check the media type and that a body came back.
    const actual = res.headers['content-type'] ?? '';
    expect(
      Object.keys(content).some((type) => actual.startsWith(type)),
      `${method} ${path} ${res.status} content-type ${actual} is not documented`,
    ).toBe(true);
    expect(res.text.length).toBeGreaterThan(0);
  } else {
    expect(res.text ?? '').toBe('');
  }
}

/** Validates a value against a named component schema, for responses not tied to one operation. */
export async function expectSchema(value: unknown, schemaName: string): Promise<void> {
  const doc = await document();
  const schema = doc.components.schemas?.[schemaName] as Schema | undefined;
  expect(schema, `schema ${schemaName} exists`).toBeDefined();
  validate(schema!, value, schemaName);
}
