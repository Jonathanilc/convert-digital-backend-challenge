import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { loadOpenApiDocument, OPENAPI_PATH } from '../helpers/openapi.js';

const RATE_LIMIT_HEADERS = [
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'RateLimit-Policy',
];

describe('openapi.yaml', () => {
  it('is a valid OpenAPI 3.1 document with resolvable references', async () => {
    const api = (await SwaggerParser.validate(OPENAPI_PATH)) as { openapi?: string };
    expect(api.openapi).toBe('3.1.0');
  });

  it('documents 429 and 503 on every rate-limited operation', async () => {
    const doc = await loadOpenApiDocument();
    const limited = Object.entries(doc.paths).filter(([path]) => path.startsWith('/api/'));
    expect(limited.length).toBeGreaterThan(0);

    for (const [path, item] of limited) {
      for (const [method, operation] of Object.entries(item)) {
        if (method === 'parameters') continue;
        expect(operation.responses, `${method.toUpperCase()} ${path}`).toHaveProperty('429');
        expect(operation.responses, `${method.toUpperCase()} ${path}`).toHaveProperty('503');
      }
    }
  });

  it('advertises RateLimit-* headers on every successful rate-limited response', async () => {
    const doc = await loadOpenApiDocument();
    for (const [path, item] of Object.entries(doc.paths)) {
      if (!path.startsWith('/api/')) continue;
      for (const [method, operation] of Object.entries(item)) {
        if (method === 'parameters') continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!status.startsWith('2')) continue;
          const headers = Object.keys(response.headers ?? {});
          expect(headers, `${method.toUpperCase()} ${path} ${status}`).toEqual(
            expect.arrayContaining(RATE_LIMIT_HEADERS),
          );
        }
      }
    }
  });

  it('keeps admin and meta endpoints outside the rate limiter (no RateLimit headers documented)', async () => {
    const doc = await loadOpenApiDocument();
    for (const [path, item] of Object.entries(doc.paths)) {
      if (path.startsWith('/api/')) continue;
      for (const [method, operation] of Object.entries(item)) {
        if (method === 'parameters') continue;
        expect(operation.responses, `${method.toUpperCase()} ${path}`).not.toHaveProperty('429');
      }
    }
  });
});
