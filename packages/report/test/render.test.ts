import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/index.js';
import { sample } from './fixtures.js';

describe('renderHtml', () => {
  it('renders one complete HTML document with provenance, a summary row per check and the evidence', () => {
    const html = renderHtml(sample());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Live verification</title>');
    expect(html).toContain('scripts/example.mts at commit abc1234');
    expect(html).toContain('2026-10-14T01:02:03.000Z');
    expect(html.match(/<tr class="check" data-status="pass"/g)).toHaveLength(2);
    expect(html.match(/<tr class="check" data-status="fail"/g)).toHaveLength(1);
    expect(html.match(/<tr class="check" data-status="skip"/g)).toHaveLength(1);
    expect(html).toContain('2/4 passed');
    expect(html).toContain('GET /health → 200');
    expect(html).toContain('Option 1 · API rate limiter');
    expect(html).toContain('Option 2 · Chat server');
  });
});
