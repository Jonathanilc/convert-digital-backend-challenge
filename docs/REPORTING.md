# Report standard

Every generated report in this repository is **one self-contained HTML file**. This page is the
standard; `packages/report` is its implementation; `docs/LIVE-VERIFICATION.html` is the first report
built to it.

## Rules

1. **One file, nothing outside it.** Styles, the small script and all data live inside the document.
   No `<link>`, no `<script src>`, no `<img>`, `<iframe>` or web fonts, no `fetch`. The file opens
   from disk (`file://`) with the network unplugged and renders the same in ten years.
2. **Built from data, not from strings at the call site.** A producer collects a `Report` (model
   below) and calls `renderHtml()`. The renderer is the only code that knows what HTML looks like.
3. **Everything is text; the renderer escapes it.** Producers never pass markup. The one inline
   notation is `` `code` `` in backticks, which renders as `<code>`.
4. **Secrets are redacted by the producer** before they enter the model (tokens, passwords, cookies).
   The renderer cannot know what is secret, so it cannot be relied on to hide it.
5. **Self-containment is asserted, not assumed.** `assertSelfContained(html)` runs on every render
   and is unit-tested against the ways a page usually leaks (stylesheets, external scripts, images,
   `@import`, `url()`, runtime network calls).
6. **Readable without JavaScript, better with it.** Structure comes from `<details>` and tables; the
   inline script only adds expand/collapse, a failures-only filter and expand-on-print. The page
   follows the OS light/dark preference and prints sensibly.
7. **Location, naming, provenance.** Reports live in `docs/<SUBJECT>.html` (upper-case subject), are
   generated, are listed in `.prettierignore` (generated files are never reformatted) and are
   committed only when the report itself is a deliverable. Every report states when, by which
   script and at which commit it was generated, and what it ran against.

## Model

```ts
interface Report {
  title: string;
  subtitle?: string;
  generatedAt: string; // ISO 8601
  generator: string; // e.g. "scripts/live-verification.mts at commit b0214f2"
  facts?: { label: string; value: string; href?: string }[]; // targets, images, versions
  sections?: ReportSection[]; // prose before the summary (method, scope)
  checks: ReportCheck[]; // the verified items, in display order
  notes?: ReportSection[]; // prose after the evidence (what was not verified, and why)
}

interface ReportCheck {
  id: string; // "1.5"; also the anchor
  group?: string; // "Option 1 · API rate limiter"; a sub-heading in the summary
  title: string; // the requirement
  scenario: string; // how it was verified
  status: 'pass' | 'fail' | 'skip';
  startedAt: string; // ISO 8601
  durationMs: number;
  evidence: string[]; // preformatted, already redacted lines
  error?: string; // failure or skip reason
}

interface ReportSection {
  title: string;
  paragraphs?: string[];
  items?: { title?: string; text: string }[];
}
```

## Producing a report

```ts
import { renderHtml, type Report } from '@challenge/report'; // or ../packages/report/src/index.ts from a script

const report: Report = {
  title: '…',
  generatedAt: new Date().toISOString(),
  generator: '…',
  checks,
};
writeFileSync('docs/SUBJECT.html', renderHtml(report)); // throws if the page is not self-contained
```

## Reports in this repository

| Report                        | Producer                        | Command            |
| ----------------------------- | ------------------------------- | ------------------ |
| `docs/LIVE-VERIFICATION.html` | `scripts/live-verification.mts` | `make verify-live` |

## Viewing

GitHub shows the _source_ of an HTML file, not the page. Open a report from a checkout
(`open docs/LIVE-VERIFICATION.html`) or download the raw file; nothing else is needed.
