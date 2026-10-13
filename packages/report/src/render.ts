import type { Report, ReportCheck, ReportFact, ReportSection } from './model.js';
import { STYLES, SCRIPT } from './assets.js';
import { assertSelfContained } from './self-contained.js';

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
/** Every string from the producer passes through here; the renderer is the only code that emits markup. */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
const e = escapeHtml;
/** Escaped prose with the one inline notation the standard allows: `code` in backticks. */
export const inline = (text: string): string => e(text).replace(/`([^`]+)`/g, '<code>$1</code>');
/** Escaped evidence; "→ 200" style status codes get a class so the stylesheet can colour them. */
const evidenceLine = (line: string): string =>
  e(line).replace(
    /→ (\d)(\d{2})\b/g,
    (_m, first: string, rest: string) => `→ <span class="st st-${first}xx">${first}${rest}</span>`,
  );

function facts(items: ReportFact[] | undefined): string {
  if (!items?.length) return '';
  const rows = items.map((f) => {
    const value = f.href
      ? `<a href="${e(f.href)}" target="_blank" rel="noopener noreferrer">${e(f.value)}</a>`
      : `<code>${e(f.value)}</code>`;
    return `<div><dt>${e(f.label)}</dt><dd>${value}</dd></div>`;
  });
  return `<dl class="facts">\n${rows.join('\n')}\n</dl>`;
}

function sections(items: ReportSection[] | undefined): string {
  if (!items?.length) return '';
  return items
    .map((sec) => {
      const paragraphs = (sec.paragraphs ?? []).map((p) => `<p>${inline(p)}</p>`);
      const bullets = (sec.items ?? []).map(
        (it) =>
          `<li>${it.title ? `<strong>${inline(it.title)}.</strong> ` : ''}${inline(it.text)}</li>`,
      );
      const list = bullets.length ? `<ul>\n${bullets.join('\n')}\n</ul>` : '';
      return `<section class="prose">\n<h2>${e(sec.title)}</h2>\n${paragraphs.join('\n')}\n${list}\n</section>`;
    })
    .join('\n');
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const anchor = (id: string): string => `check-${id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;

function summaryRows(checks: ReportCheck[]): string {
  const rows: string[] = [];
  let group: string | undefined;
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      if (group) rows.push(`<tr class="group"><th colspan="5">${e(group)}</th></tr>`);
    }
    rows.push(
      `<tr class="check" data-status="${c.status}"><td class="id"><a href="#${anchor(c.id)}">${e(c.id)}</a></td>` +
        `<td>${e(c.title)}</td><td class="scenario">${e(c.scenario)}</td>` +
        `<td><span class="pill ${c.status}">${c.status.toUpperCase()}</span></td><td class="num">${seconds(c.durationMs)}</td></tr>`,
    );
  }
  return rows.join('\n');
}

function details(c: ReportCheck): string {
  return `<details class="check" id="${anchor(c.id)}" data-status="${c.status}"${c.status === 'fail' ? ' open' : ''}>
<summary><span class="pill ${c.status}">${c.status.toUpperCase()}</span> <span class="id">${e(c.id)}</span> <span class="title">${e(c.title)}</span><span class="meta">started ${e(c.startedAt)} · ${seconds(c.durationMs)}</span></summary>
<p class="scenario"><strong>Scenario.</strong> ${e(c.scenario)}</p>
${c.error ? `<p class="reason ${c.status}">${e(c.error)}</p>` : ''}
${c.evidence.length ? `<pre class="evidence">${c.evidence.map(evidenceLine).join('\n')}</pre>` : '<p class="empty">No evidence recorded.</p>'}
</details>`;
}

export function renderHtml(report: Report): string {
  const total = report.checks.length;
  const count = (status: ReportCheck['status']): number =>
    report.checks.filter((c) => c.status === status).length;
  const passed = count('pass');
  const failed = count('fail');
  const skipped = count('skip');
  const result = failed > 0 ? 'fail' : 'pass';
  const headline = [
    `${passed}/${total} passed`,
    failed > 0 && `${failed} failed`,
    skipped > 0 && `${skipped} skipped`,
  ]
    .filter(Boolean)
    .join(' · ');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(report.title)}</title>
<style>${STYLES}</style>
</head>
<body data-result="${result}">
<header class="top">
<div>
<h1>${e(report.title)}</h1>
${report.subtitle ? `<p class="subtitle">${e(report.subtitle)}</p>` : ''}
<p class="provenance">Generated <time datetime="${e(report.generatedAt)}">${e(report.generatedAt)}</time> by ${inline(report.generator)}.</p>
</div>
<p class="result ${result}">${headline}</p>
</header>
<main>
${facts(report.facts)}
${sections(report.sections)}
<section id="summary">
<h2>Summary</h2>
<div class="toolbar"><button type="button" id="expand">Expand all</button><button type="button" id="collapse">Collapse all</button>${failed > 0 ? '<label><input type="checkbox" id="fail-only"> Failures only</label>' : ''}<span>Click a row to jump to its evidence.</span></div>
<div class="scroll">
<table class="summary">
<thead><tr><th>#</th><th>Requirement</th><th>Scenario</th><th>Result</th><th>Time</th></tr></thead>
<tbody>
${summaryRows(report.checks)}
</tbody>
</table>
</div>
</section>
<section id="evidence">
<h2>Evidence</h2>
${report.checks.map(details).join('\n')}
</section>
${sections(report.notes)}
</main>
<footer>Built to the repository's report standard (docs/REPORTING.md): one self-contained file, no external resources, every producer string escaped.</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
  assertSelfContained(html);
  return html;
}
