import type { Report } from '../src/index.js';

const at = '2026-10-14T01:00:00.000Z';

/** Two groups, every status once, evidence that tries to inject markup. */
export function sample(): Report {
  return {
    title: 'Live verification',
    subtitle: 'against the challenge requirements',
    generatedAt: '2026-10-14T01:02:03.000Z',
    generator: 'scripts/example.mts at commit abc1234',
    facts: [
      { label: 'Option 1, rate limiter', value: 'https://rl.example', href: 'https://rl.example' },
      { label: 'Deployed image', value: 'rate-limiter:abc1234' },
    ],
    sections: [
      {
        title: 'Method',
        paragraphs: ['Limits were shrunk with `overrides` for this IP only.'],
        items: [{ title: 'Scope', text: 'Both options, from one machine.' }],
      },
    ],
    checks: [
      {
        id: '1.0',
        group: 'Option 1 · API rate limiter',
        title: 'Service is up',
        scenario: 'health endpoints',
        status: 'pass',
        startedAt: at,
        durationMs: 300,
        evidence: ['GET /health → 200  body={"status":"ok"}'],
      },
      {
        id: '1.1',
        group: 'Option 1 · API rate limiter',
        title: 'Per-IP limit',
        scenario: 'walk the budget to zero',
        status: 'fail',
        startedAt: at,
        durationMs: 1234,
        evidence: ['GET /api/public → 429  retry-after=60'],
        error: 'expected 429, got 200',
      },
      {
        id: '2.0',
        group: 'Option 2 · Chat server',
        title: 'Service is up',
        scenario: 'health + contracts',
        status: 'pass',
        startedAt: at,
        durationMs: 0,
        evidence: ['<script>alert(1)</script> & "quotes"'],
      },
      {
        id: '2.9',
        group: 'Option 2 · Chat server',
        title: 'Redis outage',
        scenario: 'fail-open',
        status: 'skip',
        startedAt: at,
        durationMs: 0,
        evidence: [],
        error: 'needs the shared Redis down',
      },
    ],
    notes: [
      {
        title: 'Not verified live',
        items: [{ title: 'Fail-open', text: 'Covered by unit tests.' }],
      },
    ],
  };
}
