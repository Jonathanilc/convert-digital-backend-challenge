import { describe, expect, it } from 'vitest';
import { assertSelfContained, renderHtml } from '../src/index.js';
import { sample } from './fixtures.js';

const page = (head: string, body = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

describe('assertSelfContained', () => {
  it('accepts what the renderer produces', () => {
    expect(() => assertSelfContained(renderHtml(sample()))).not.toThrow();
  });

  it.each([
    ['an external stylesheet', page('<link rel="stylesheet" href="https://cdn.example/a.css">')],
    ['an external script', page('<script src="https://cdn.example/a.js"></script>')],
    [
      'a module script',
      page('<script type="module">import x from "https://cdn.example/a.js"</script>'),
    ],
    ['an image', page('', '<img src="https://cdn.example/a.png">')],
    ['an iframe', page('', '<iframe src="https://example.com"></iframe>')],
    ['a CSS @import', page('<style>@import url("https://fonts.example/a.css");</style>')],
    [
      'a CSS url() to the network',
      page('<style>body{background:url(https://cdn.example/a.png)}</style>'),
    ],
    ['a CSS url() to a relative file', page('<style>body{background:url(a.png)}</style>')],
    ['runtime network access in a script', page('<script>fetch("/api")</script>')],
    ['a URL inside a script', page('<script>location.href="https://example.com"</script>')],
    ['a meta refresh', page('<meta http-equiv="refresh" content="0;url=https://example.com">')],
  ])('rejects %s', (_name, html) => {
    expect(() => assertSelfContained(html)).toThrow(/not self-contained/);
  });

  it('allows navigation links, data: URIs and escaped text that merely mentions tags or calls', () => {
    const html = page(
      '<style>a::before{background:url(data:image/png;base64,AAAA)}</style>',
      '<a href="https://example.com">a link</a> &lt;img src=x&gt; &lt;link&gt; fetch(',
    );
    expect(() => assertSelfContained(html)).not.toThrow();
  });

  it('requires a doctype and a charset, so the file renders the same everywhere', () => {
    expect(() => assertSelfContained('<html><body>x</body></html>')).toThrow(/doctype/);
    expect(() => assertSelfContained('<!doctype html><html><body>x</body></html>')).toThrow(
      /charset/,
    );
  });
});
