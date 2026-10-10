import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { loadOpenApiDocument, OPENAPI_PATH } from '../helpers/openapi.js';

describe('openapi.yaml', () => {
  it('is a valid OpenAPI 3.1 document with resolvable references', async () => {
    const api = (await SwaggerParser.validate(OPENAPI_PATH)) as { openapi?: string };
    expect(api.openapi).toBe('3.1.0');
  });

  it('documents 401 and 403 on every bearer-protected operation (banned accounts get 403 anywhere)', async () => {
    const doc = await loadOpenApiDocument();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (method === 'parameters') continue;
        const protectedOp = (op.security ?? []).some((s) => 'bearerAuth' in s);
        if (protectedOp) {
          expect(op.responses, `${method.toUpperCase()} ${path}`).toHaveProperty('401');
          expect(op.responses, `${method.toUpperCase()} ${path}`).toHaveProperty('403');
        }
        if (path.startsWith('/admin/'))
          expect(op.responses, `${method.toUpperCase()} ${path}`).toHaveProperty('403');
      }
    }
  });

  it('rate limits and documents 429 on the auth endpoints only', async () => {
    const doc = await loadOpenApiDocument();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (method === 'parameters') continue;
        const has429 = Object.prototype.hasOwnProperty.call(op.responses, '429');
        expect(has429, `${method.toUpperCase()} ${path}`).toBe(path.startsWith('/auth/'));
      }
    }
  });
});
