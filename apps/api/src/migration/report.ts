import { BUNDLE_FORMAT_VERSION, REPORT_SCHEMA_VERSION } from "./constants.js";
import type { AuthenticityResult, IntegrityResult } from "./bundle.js";

/**
 * The verification report: ONE schema for source preflight, destination
 * preflight and bundle verification, so the CLI and the future wizard render the
 * same thing. Reports carry names, counts and sizes — NEVER secret values,
 * environment values, passphrases or key material.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "skip" | "info";

export type CheckDataValue = string | number | boolean | null;

export interface CheckResult {
  /** Stable machine id, e.g. "source.crypto.credentials". */
  id: string;
  title: string;
  status: CheckStatus;
  /** Plain-language explanation of what was found. */
  detail: string;
  /** What the operator should do, when status is warn/fail. */
  remediation?: string;
  /** Subject ref this check concerns, e.g. "app:12". */
  subject?: string;
  data?: Record<string, CheckDataValue>;
}

export type Verdict = "ready" | "ready-with-warnings" | "blocked";

export interface ReportSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  info: number;
}

export interface VerificationReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  kind: "preflight" | "bundle-verification" | "destination-descriptor" | "export";
  role: "source" | "destination";
  scope: "platform" | "application";
  generatedAt: string;
  tool: { name: "clovaforge-migration"; bundleFormatVersion: number };
  /** The application this report is about (application scope only). */
  application?: { id: number; name: string };
  verdict: Verdict;
  summary: ReportSummary;
  checks: CheckResult[];
  /** Present when a bundle was examined: the two properties are reported separately. */
  integrity?: IntegrityResult;
  authenticity?: AuthenticityResult;
  /** Free-form structured sections (assessments, dependency analysis, plan, estimates). */
  sections: Record<string, unknown>;
  readOnly: { guaranteed: true; note: string };
}

export const READ_ONLY_NOTE =
  "This report was produced by a read-only inspection. No service was started, stopped, " +
  "created, removed or reconfigured, and no application data was modified.";

export function summarize(checks: CheckResult[]): ReportSummary {
  const summary: ReportSummary = { pass: 0, warn: 0, fail: 0, skip: 0, info: 0 };

  for (const check of checks) {
    summary[check.status] += 1;
  }

  return summary;
}

export function verdictFor(summary: ReportSummary): Verdict {
  if (summary.fail > 0) {
    return "blocked";
  }

  return summary.warn > 0 ? "ready-with-warnings" : "ready";
}

export function buildReport(input: {
  kind: VerificationReport["kind"];
  role: VerificationReport["role"];
  scope: VerificationReport["scope"];
  checks: CheckResult[];
  application?: VerificationReport["application"];
  integrity?: IntegrityResult;
  authenticity?: AuthenticityResult;
  sections?: Record<string, unknown>;
  now?: Date;
}): VerificationReport {
  const summary = summarize(input.checks);
  let verdict = verdictFor(summary);

  // A bundle whose integrity or authenticity FAILED can never be "ready".
  if (input.integrity?.status === "failed" || input.authenticity?.status === "failed") {
    verdict = "blocked";
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: input.kind,
    role: input.role,
    scope: input.scope,
    generatedAt: (input.now ?? new Date()).toISOString(),
    tool: { name: "clovaforge-migration", bundleFormatVersion: BUNDLE_FORMAT_VERSION },
    application: input.application,
    verdict,
    summary,
    checks: input.checks,
    integrity: input.integrity,
    authenticity: input.authenticity,
    sections: input.sections ?? {},
    readOnly: { guaranteed: true, note: READ_ONLY_NOTE }
  };
}

const MARK: Record<CheckStatus, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  skip: "SKIP",
  info: "INFO"
};

const VERDICT_TEXT: Record<Verdict, string> = {
  ready: "READY",
  "ready-with-warnings": "READY WITH WARNINGS",
  blocked: "BLOCKED"
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Human-readable rendering of a report. Never prints anything the JSON does not contain. */
export function renderReportText(report: VerificationReport): string {
  const lines: string[] = [];
  const title =
    report.kind === "export"
      ? "Export"
      : report.kind === "bundle-verification"
      ? "Bundle verification"
      : report.kind === "destination-descriptor"
        ? "Destination description"
        : `${report.role === "source" ? "Source" : "Destination"} preflight`;

  lines.push(`${title} — scope: ${report.scope}${report.application ? ` — app: ${report.application.name}` : ""}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Verdict:   ${VERDICT_TEXT[report.verdict]}`);
  lines.push(
    `Checks:    ${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failed, ` +
      `${report.summary.skip} skipped`
  );
  lines.push("");

  if (report.integrity) {
    lines.push(
      `INTEGRITY    ${report.integrity.status.toUpperCase()} (${report.integrity.depth} verification, ` +
        `${report.integrity.artifactsChecked} artifact(s) checked)`
    );
    for (const problem of report.integrity.problems) {
      lines.push(`  - [${problem.code}] ${problem.message}`);
    }
  }
  if (report.authenticity) {
    lines.push(`AUTHENTICITY ${report.authenticity.status.toUpperCase()}`);
    if (report.authenticity.signerFingerprint) {
      lines.push(
        `  signer: ${report.authenticity.signerFingerprint}${report.authenticity.pinned ? " (pinned)" : " (NOT pinned)"}`
      );
    }
    for (const note of report.authenticity.notes) {
      lines.push(`  - ${note}`);
    }
  }
  if (report.integrity || report.authenticity) {
    lines.push("");
  }

  const order: CheckStatus[] = ["fail", "warn", "pass", "info", "skip"];
  const sorted = [...report.checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  for (const check of sorted) {
    lines.push(`[${MARK[check.status]}] ${check.title}${check.subject ? ` (${check.subject})` : ""}`);
    lines.push(`       ${check.detail}`);
    if (check.remediation && (check.status === "fail" || check.status === "warn")) {
      lines.push(`       → ${check.remediation}`);
    }
  }

  lines.push("");
  lines.push(report.readOnly.note);

  return lines.join("\n");
}
