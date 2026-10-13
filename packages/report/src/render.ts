import type { Report, ReportCheck } from './model.js';
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
<pre class="evidence">${c.evidence.map(e).join('\n')}</pre>
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
</head>
<body data-result="${result}">
<header class="top">
<div>
<h1>${e(report.title)}</h1>
${report.subtitle ? `<p class="subtitle">${e(report.subtitle)}</p>` : ''}
<p class="provenance">Generated <time datetime="${e(report.generatedAt)}">${e(report.generatedAt)}</time> by ${e(report.generator)}.</p>
</div>
<p class="result ${result}">${headline}</p>
</header>
<main>
<section id="summary">
<h2>Summary</h2>
<table class="summary">
<thead><tr><th>#</th><th>Requirement</th><th>Scenario</th><th>Result</th><th>Time</th></tr></thead>
<tbody>
${summaryRows(report.checks)}
</tbody>
</table>
</section>
<section id="evidence">
<h2>Evidence</h2>
${report.checks.map(details).join('\n')}
</section>
</main>
</body>
</html>
`;
  assertSelfContained(html);
  return html;
}
