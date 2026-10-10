/**
 * Generates TypeScript types for every WebSocket frame from asyncapi.yaml.
 *   tsx scripts/asyncapi-types.ts          write src/generated/ws-messages.d.ts
 *   tsx scripts/asyncapi-types.ts --check  exit 1 if the checked-in file is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
import { loadWsSchemas } from '../src/ws/schemas.js';

const OUT = fileURLToPath(new URL('../src/generated/ws-messages.d.ts', import.meta.url));

const schema = loadWsSchemas();
// json-schema-to-typescript only declares definitions reachable from the root, so the root
// object references every definition once; it doubles as a name → type map.
const root = {
  ...schema,
  type: 'object',
  additionalProperties: false,
  required: Object.keys(schema.$defs),
  properties: Object.fromEntries(
    Object.keys(schema.$defs).map((name) => [name, { $ref: `#/$defs/${name}` }]),
  ),
};
const generated = await compile(root as Parameters<typeof compile>[0], 'ChatWsSchemas', {
  bannerComment:
    '/* eslint-disable */\n/** Generated from asyncapi.yaml by scripts/asyncapi-types.ts. Do not edit. */',
  additionalProperties: false,
  strictIndexSignatures: true,
  style: { singleQuote: true, semi: true, printWidth: 100 },
});

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing */
  }
  if (current !== generated) {
    console.error('Generated WebSocket types are stale: run npm run asyncapi:types');
    process.exit(1);
  }
  console.log('WebSocket types are current');
} else {
  writeFileSync(OUT, generated);
  console.log(`wrote ${OUT}`);
}
