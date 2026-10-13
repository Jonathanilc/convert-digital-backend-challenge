export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface ReportCheck {
  /** Stable identifier shown in the summary and used as the anchor, e.g. "1.5". */
  id: string;
  /** Optional grouping rendered as a sub-heading in the summary, e.g. "Option 1 · API rate limiter". */
  group?: string;
  /** What was verified, usually the requirement. */
  title: string;
  /** How it was verified. */
  scenario: string;
  status: CheckStatus;
  /** ISO 8601. */
  startedAt: string;
  durationMs: number;
  /** Preformatted evidence lines. Already redacted by the producer. */
  evidence: string[];
  /** Failure or skip reason. */
  error?: string;
}

export interface ReportFact {
  label: string;
  value: string;
  href?: string;
}

export interface ReportItem {
  title?: string;
  text: string;
}

export interface ReportSection {
  title: string;
  paragraphs?: string[];
  items?: ReportItem[];
}

export interface Report {
  title: string;
  subtitle?: string;
  /** ISO 8601. */
  generatedAt: string;
  /** What produced the report and from which commit, e.g. "scripts/live-verification.mts at commit b0214f2". */
  generator: string;
  /** Targets, deployed images, versions. */
  facts?: ReportFact[];
  /** Prose before the summary: method, scope. */
  sections?: ReportSection[];
  /** The verified items, in display order. */
  checks: ReportCheck[];
  /** Prose after the evidence: what was not verified, and why. */
  notes?: ReportSection[];
}
