import { readFileSync } from 'node:fs';
import { Parser } from '@asyncapi/parser';
import { describe, expect, it } from 'vitest';
import {
  ASYNCAPI_PATH,
  CLIENT_FRAME_SCHEMAS,
  loadWsSchemas,
  SERVER_FRAME_SCHEMAS,
} from '../../src/ws/schemas.js';

const text = readFileSync(ASYNCAPI_PATH, 'utf8');

describe('asyncapi.yaml', () => {
  it('is a valid AsyncAPI 3 document', async () => {
    const { document, diagnostics } = await new Parser().parse(text);
    const errors = diagnostics.filter((d) => d.severity === 0);
    expect(errors.map((e) => `${e.path?.join('.')}: ${e.message}`)).toEqual([]);
    expect(document?.version()).toBe('3.0.0');
  });

  it('answers every client command with ack or error', async () => {
    const { document } = await new Parser().parse(text);
    const receives = document!.operations().filterByReceive();
    expect(receives.length).toBeGreaterThan(0);
    for (const op of receives) {
      const replyNames =
        op
          .reply()
          ?.messages()
          .map((m) => m.name()) ?? [];
      expect(replyNames, op.id()).toEqual(expect.arrayContaining(['ack', 'error']));
    }
  });

  it('gives every frame a closed object schema with a unique type discriminator', () => {
    const { $defs } = loadWsSchemas();
    const seen = new Map<string, string>();
    for (const [name, schema] of Object.entries($defs).filter(
      ([n]) => n.endsWith('Frame') && !n.startsWith('Client') && !n.startsWith('Server'),
    )) {
      const s = schema as {
        type?: string;
        additionalProperties?: boolean;
        required?: string[];
        properties?: { type?: { const?: string } };
      };
      expect(s.type, name).toBe('object');
      expect(s.additionalProperties, name).toBe(false);
      expect(s.required, name).toEqual(expect.arrayContaining(['type', 'payload']));
      const discriminator = s.properties?.type?.const;
      expect(discriminator, `${name} has a const type`).toBeTypeOf('string');
      expect(
        seen.has(discriminator!),
        `${discriminator} reused by ${seen.get(discriminator!)} and ${name}`,
      ).toBe(false);
      seen.set(discriminator!, name);
    }
  });

  it('keeps the runtime discriminator maps in sync with the oneOf unions', () => {
    const { $defs } = loadWsSchemas();
    const refs = (name: string) =>
      (($defs[name] as { oneOf: Array<{ $ref: string }> }).oneOf ?? []).map((r) =>
        r.$ref.replace('#/$defs/', ''),
      );
    expect(refs('ClientFrame').sort()).toEqual(Object.values(CLIENT_FRAME_SCHEMAS).sort());
    expect(refs('ServerFrame').sort()).toEqual(Object.values(SERVER_FRAME_SCHEMAS).sort());
    for (const [type, schemaName] of [
      ...Object.entries(CLIENT_FRAME_SCHEMAS),
      ...Object.entries(SERVER_FRAME_SCHEMAS),
    ]) {
      expect(
        ($defs[schemaName] as { properties: { type: { const: string } } }).properties.type.const,
        schemaName,
      ).toBe(type);
    }
  });
});
