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

describe('escaping', () => {
  it('escapes every piece of producer text, so evidence and titles cannot inject markup', () => {
    const html = renderHtml(sample());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');

    const hostile = sample();
    hostile.title = '<b>x</b>';
    hostile.checks[0]!.title = 'a < b';
    const h = renderHtml(hostile);
    expect(h).toContain('<title>&lt;b&gt;x&lt;/b&gt;</title>');
    expect(h).toContain('a &lt; b');
    expect(h).not.toContain('<b>x</b>');
  });
});

describe('failures and skips', () => {
  it('opens failed evidence, keeps passing evidence collapsed, shows reasons and marks the document result', () => {
    const html = renderHtml(sample());
    expect(html).toContain('<body data-result="fail"');
    expect(html).toMatch(/<details class="check" id="check-1-1" data-status="fail" open>/);
    expect(html).toMatch(/<details class="check" id="check-1-0" data-status="pass">/);
    expect(html).toMatch(/<details class="check" id="check-2-9" data-status="skip">/);
    expect(html).toContain('expected 429, got 200');
    expect(html).toContain('needs the shared Redis down');
    expect(html).toContain('2/4 passed · 1 failed · 1 skipped');
  });

  it('reports a clean run as a pass', () => {
    const clean = sample();
    clean.checks = clean.checks.filter((c) => c.status === 'pass');
    const html = renderHtml(clean);
    expect(html).toContain('<body data-result="pass"');
    expect(html).toContain('2/2 passed');
    expect(html).not.toContain('failed');
  });
});
