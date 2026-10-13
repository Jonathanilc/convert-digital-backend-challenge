/**
 * Throws unless the document can be opened from disk, offline, and render completely: no external
 * stylesheets, scripts, images or frames, no CSS imports or url() to files, no network access from
 * the inline script. Markup checks run on the whole document (producer text is escaped, so a real
 * `<img` can only be markup); CSS and JavaScript checks run on the <style> and <script> bodies only,
 * so evidence that merely mentions `fetch(` is not a false positive.
 */
export function assertSelfContained(html: string): void {
  const fail = (why: string): never => {
    throw new Error(`report is not self-contained: ${why}`);
  };
  if (!/^\s*<!doctype html>/i.test(html)) fail('missing <!doctype html>');
  if (!/<meta\s[^>]*charset=/i.test(html)) fail('missing <meta charset>');

  const markup: Array<[RegExp, string]> = [
    [/<link\b/i, 'a <link> element'],
    [/<script\b[^>]*\bsrc\s*=/i, 'an external script'],
    [/<script\b[^>]*\btype\s*=\s*["']?module/i, 'a module script'],
    [
      /<(img|picture|iframe|frame|object|embed|video|audio|source|track|portal)\b/i,
      'an embedded resource element',
    ],
    [/<base\b/i, 'a <base> element'],
    [/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, 'a meta refresh'],
  ];
  for (const [pattern, why] of markup) if (pattern.test(html)) fail(why);

  for (const css of blocks(html, 'style')) {
    if (/@import\b/i.test(css)) fail('a CSS @import');
    if (/\burl\(\s*(?!["']?data:)/i.test(css)) fail('a CSS url() that is not a data: URI');
  }
  for (const js of blocks(html, 'script')) {
    if (
      /\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon|open)\s*\(/.test(js)
    )
      fail('network access from the inline script');
    if (/\bimport\s*\(|^\s*import\s/m.test(js)) fail('an import in the inline script');
    if (/https?:\/\//i.test(js)) fail('a URL inside the inline script');
  }
}

function blocks(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[1] ?? '');
}
