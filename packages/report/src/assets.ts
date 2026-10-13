/** Inline stylesheet. No url(), no @import: assertSelfContained() rejects both. */
export const STYLES = `
:root { color-scheme: light dark;
  --bg: #ffffff; --fg: #1b1f23; --muted: #59636e; --line: #d9dee3; --card: #f6f8fa; --code: #eff1f3;
  --pass: #1a7f37; --pass-bg: #dafbe1; --fail: #cf222e; --fail-bg: #ffebe9; --skip: #9a6700; --skip-bg: #fff8c5; --link: #0969da;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
@media (prefers-color-scheme: dark) { :root {
  --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --card: #161b22; --code: #1f242c;
  --pass: #3fb950; --pass-bg: #12261e; --fail: #f85149; --fail-bg: #2d1416; --skip: #d29922; --skip-bg: #2a2210; --link: #58a6ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); }
header.top, main, footer { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
header.top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 16px 24px; padding-top: 32px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 4px; }
.subtitle { margin: 0; color: var(--muted); font-size: 17px; }
.provenance { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
.result { margin: 0; padding: 10px 16px; border-radius: 999px; font-weight: 600; white-space: nowrap; }
.result.pass { background: var(--pass-bg); color: var(--pass); }
.result.fail { background: var(--fail-bg); color: var(--fail); }
h2 { font-size: 20px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
a { color: var(--link); }
code { font: 13px var(--mono); background: var(--code); padding: 1px 5px; border-radius: 4px; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin: 24px 0 0; }
.facts div { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; min-width: 0; }
.facts dt { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.facts dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.prose p, .prose li { max-width: 80ch; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 0 0 12px; font-size: 13px; color: var(--muted); }
.toolbar button { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.toolbar label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
.scroll { overflow-x: auto; }
table.summary { width: 100%; border-collapse: collapse; font-size: 14px; }
table.summary th, table.summary td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
table.summary thead th { position: sticky; top: 0; background: var(--bg); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
table.summary tr.group th { background: var(--card); font-weight: 600; }
table.summary td.id { white-space: nowrap; font: 13px var(--mono); }
table.summary td.scenario { color: var(--muted); }
table.summary td.num { text-align: right; white-space: nowrap; font: 13px var(--mono); }
.pill { display: inline-block; font: 600 11px/1 var(--mono); letter-spacing: 0.04em; padding: 4px 7px; border-radius: 999px; }
.pill.pass { background: var(--pass-bg); color: var(--pass); }
.pill.fail { background: var(--fail-bg); color: var(--fail); }
.pill.skip { background: var(--skip-bg); color: var(--skip); }
details.check { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 12px; background: var(--card); }
details.check[data-status="fail"] { border-color: var(--fail); }
details.check summary { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 10px 14px; cursor: pointer; list-style: none; }
details.check summary::-webkit-details-marker { display: none; }
details.check summary .id { font: 13px var(--mono); color: var(--muted); }
details.check summary .title { font-weight: 600; flex: 1 1 auto; }
details.check summary .meta { font-size: 12px; color: var(--muted); white-space: nowrap; }
details.check > :not(summary) { margin: 0 14px 12px; }
details.check .scenario { color: var(--muted); }
details.check .reason { font-weight: 600; color: var(--fail); }
details.check .reason.skip { color: var(--skip); }
pre.evidence { font: 12.5px/1.55 var(--mono); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; white-space: pre-wrap; overflow-wrap: anywhere; margin-bottom: 14px; }
.st { font-weight: 700; } .st-2xx { color: var(--pass); } .st-3xx { color: var(--link); } .st-4xx { color: var(--skip); } .st-5xx { color: var(--fail); }
.empty { color: var(--muted); font-style: italic; }
.fail-only [data-status="pass"], .fail-only [data-status="skip"] { display: none; }
footer { color: var(--muted); font-size: 12px; padding-top: 24px; padding-bottom: 40px; }
@media print { .toolbar { display: none; } details.check { break-inside: avoid; } table.summary thead th { position: static; } }
`;

/** Inline script: progressive enhancement only. No network calls, no imports, no URLs (all rejected by assertSelfContained). */
export const SCRIPT = `
(function () {
  var all = document.querySelectorAll('details.check');
  function setAll(state) { all.forEach(function (d) { d.open = state; }); }
  function reveal(hash) {
    if (!hash || hash.length < 2) return;
    var target = document.getElementById(hash.slice(1));
    if (target && target.tagName === 'DETAILS') target.open = true;
  }
  var expand = document.getElementById('expand');
  var collapse = document.getElementById('collapse');
  var failOnly = document.getElementById('fail-only');
  if (expand) expand.addEventListener('click', function () { setAll(true); });
  if (collapse) collapse.addEventListener('click', function () { setAll(false); });
  if (failOnly) failOnly.addEventListener('change', function () { document.body.classList.toggle('fail-only', failOnly.checked); });
  window.addEventListener('beforeprint', function () { setAll(true); });
  window.addEventListener('hashchange', function () { reveal(location.hash); });
  reveal(location.hash);
})();
`;
