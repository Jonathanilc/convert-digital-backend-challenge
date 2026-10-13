import type { Report, ReportCheck } from './model.js';

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const anchor = (id: string): string => `check-${id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;

function summaryRows(checks: ReportCheck[]): string {
  const rows: string[] = [];
  let group: string | undefined;
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      if (group) rows.push(`<tr class="group"><th colspan="5">${group}</th></tr>`);
    }
    rows.push(
      `<tr class="check" data-status="${c.status}"><td class="id"><a href="#${anchor(c.id)}">${c.id}</a></td>` +
        `<td>${c.title}</td><td class="scenario">${c.scenario}</td>` +
        `<td><span class="pill ${c.status}">${c.status.toUpperCase()}</span></td><td class="num">${seconds(c.durationMs)}</td></tr>`,
    );
  }
  return rows.join('\n');
}

function details(c: ReportCheck): string {
  return `<details class="check" id="${anchor(c.id)}">
<summary><span class="pill ${c.status}">${c.status.toUpperCase()}</span> <span class="id">${c.id}</span> <span class="title">${c.title}</span><span class="meta">started ${c.startedAt} · ${seconds(c.durationMs)}</span></summary>
<p class="scenario"><strong>Scenario.</strong> ${c.scenario}</p>
<pre class="evidence">${c.evidence.join('\n')}</pre>
</details>`;
}

export function renderHtml(report: Report): string {
  const total = report.checks.length;
  const passed = report.checks.filter((c) => c.status === 'pass').length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${report.title}</title>
</head>
<body>
<header class="top">
<div>
<h1>${report.title}</h1>
${report.subtitle ? `<p class="subtitle">${report.subtitle}</p>` : ''}
<p class="provenance">Generated <time datetime="${report.generatedAt}">${report.generatedAt}</time> by ${report.generator}.</p>
</div>
<p class="result">${passed}/${total} passed</p>
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
}
