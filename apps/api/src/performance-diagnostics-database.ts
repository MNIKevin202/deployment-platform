import type { DatabaseSync } from "node:sqlite";

export interface PublicProbeRecord {
  ok: boolean;
  totalMs: number | null;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  statusCode: number | null;
  responseBytes: number | null;
  redirectCount: number;
  finalHost: string | null;
  error: string | null;
}

export interface InternalProbeRecord {
  ok: boolean;
  totalMs: number | null;
  connectMs: number | null;
  ttfbMs: number | null;
  statusCode: number | null;
  responseBytes: number | null;
  error: string | null;
  port: number | null;
}

export interface CreateDiagnosticRunInput {
  appId: number;
  publicProbe: PublicProbeRecord;
  internalProbe: InternalProbeRecord;
  diagnosisCategory: string;
  diagnosisMessage: string;
  evidence: string[];
}

export interface BrowserDiagnosticsUpdateInput {
  available: boolean;
  dnsMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  pageLoadMs: number | null;
  totalNavigationMs: number | null;
  transferBytes: number | null;
  resourceSummary: unknown;
  topResources: unknown;
  diagnosisCategory: string;
  diagnosisMessage: string;
  evidence: string[];
}

export interface StoredPerformanceDiagnostic {
  id: number;
  appId: number;
  createdAt: string;
  publicProbe: PublicProbeRecord;
  internalProbe: InternalProbeRecord;
  browserSubmittedAt: string | null;
  browserAvailable: boolean;
  browserDnsMs: number | null;
  browserTlsMs: number | null;
  browserTtfbMs: number | null;
  browserPageLoadMs: number | null;
  browserTotalNavigationMs: number | null;
  browserTransferBytes: number | null;
  resourceSummary: unknown;
  topResources: unknown;
  diagnosisCategory: string | null;
  diagnosisMessage: string | null;
  evidence: string[];
}

interface DiagnosticRow {
  id: number;
  app_id: number;
  created_at: string;
  public_ok: number;
  public_total_ms: number | null;
  public_dns_ms: number | null;
  public_connect_ms: number | null;
  public_tls_ms: number | null;
  public_ttfb_ms: number | null;
  public_download_ms: number | null;
  public_status_code: number | null;
  public_response_bytes: number | null;
  public_redirect_count: number;
  public_final_host: string | null;
  public_error: string | null;
  internal_ok: number;
  internal_total_ms: number | null;
  internal_connect_ms: number | null;
  internal_ttfb_ms: number | null;
  internal_status_code: number | null;
  internal_response_bytes: number | null;
  internal_error: string | null;
  internal_port: number | null;
  browser_submitted_at: string | null;
  browser_available: number;
  browser_dns_ms: number | null;
  browser_tls_ms: number | null;
  browser_ttfb_ms: number | null;
  browser_page_load_ms: number | null;
  browser_total_navigation_ms: number | null;
  browser_transfer_bytes: number | null;
  resource_summary_json: string | null;
  top_resources_json: string | null;
  diagnosis_category: string | null;
  diagnosis_message: string | null;
  evidence_json: string | null;
}

const DIAGNOSTIC_COLUMNS = `
  id, app_id, created_at,
  public_ok, public_total_ms, public_dns_ms, public_connect_ms, public_tls_ms,
  public_ttfb_ms, public_download_ms, public_status_code, public_response_bytes,
  public_redirect_count, public_final_host, public_error,
  internal_ok, internal_total_ms, internal_connect_ms, internal_ttfb_ms,
  internal_status_code, internal_response_bytes, internal_error, internal_port,
  browser_submitted_at, browser_available, browser_dns_ms, browser_tls_ms,
  browser_ttfb_ms, browser_page_load_ms, browser_total_navigation_ms,
  browser_transfer_bytes, resource_summary_json, top_resources_json,
  diagnosis_category, diagnosis_message, evidence_json
`;

function parseJsonSafely(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapRow(row: DiagnosticRow): StoredPerformanceDiagnostic {
  return {
    id: row.id,
    appId: row.app_id,
    createdAt: row.created_at,
    publicProbe: {
      ok: row.public_ok === 1,
      totalMs: row.public_total_ms,
      dnsMs: row.public_dns_ms,
      connectMs: row.public_connect_ms,
      tlsMs: row.public_tls_ms,
      ttfbMs: row.public_ttfb_ms,
      downloadMs: row.public_download_ms,
      statusCode: row.public_status_code,
      responseBytes: row.public_response_bytes,
      redirectCount: row.public_redirect_count,
      finalHost: row.public_final_host,
      error: row.public_error
    },
    internalProbe: {
      ok: row.internal_ok === 1,
      totalMs: row.internal_total_ms,
      connectMs: row.internal_connect_ms,
      ttfbMs: row.internal_ttfb_ms,
      statusCode: row.internal_status_code,
      responseBytes: row.internal_response_bytes,
      error: row.internal_error,
      port: row.internal_port
    },
    browserSubmittedAt: row.browser_submitted_at,
    browserAvailable: row.browser_available === 1,
    browserDnsMs: row.browser_dns_ms,
    browserTlsMs: row.browser_tls_ms,
    browserTtfbMs: row.browser_ttfb_ms,
    browserPageLoadMs: row.browser_page_load_ms,
    browserTotalNavigationMs: row.browser_total_navigation_ms,
    browserTransferBytes: row.browser_transfer_bytes,
    resourceSummary: parseJsonSafely(row.resource_summary_json),
    topResources: parseJsonSafely(row.top_resources_json),
    diagnosisCategory: row.diagnosis_category,
    diagnosisMessage: row.diagnosis_message,
    evidence: (parseJsonSafely(row.evidence_json) as string[] | null) ?? []
  };
}

/** Only the latest N rows per app are ever kept — older rows are deleted right after each insert. */
const MAX_HISTORY_PER_APP = 20;

export function createPerformanceDiagnosticsRepository(db: DatabaseSync) {
  function createDiagnosticRun(input: CreateDiagnosticRunInput): StoredPerformanceDiagnostic {
    const result = db
      .prepare(
        `
          INSERT INTO app_performance_diagnostics (
            app_id,
            public_ok, public_total_ms, public_dns_ms, public_connect_ms, public_tls_ms,
            public_ttfb_ms, public_download_ms, public_status_code, public_response_bytes,
            public_redirect_count, public_final_host, public_error,
            internal_ok, internal_total_ms, internal_connect_ms, internal_ttfb_ms,
            internal_status_code, internal_response_bytes, internal_error, internal_port,
            diagnosis_category, diagnosis_message, evidence_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.appId,
        input.publicProbe.ok ? 1 : 0,
        input.publicProbe.totalMs,
        input.publicProbe.dnsMs,
        input.publicProbe.connectMs,
        input.publicProbe.tlsMs,
        input.publicProbe.ttfbMs,
        input.publicProbe.downloadMs,
        input.publicProbe.statusCode,
        input.publicProbe.responseBytes,
        input.publicProbe.redirectCount,
        input.publicProbe.finalHost,
        input.publicProbe.error,
        input.internalProbe.ok ? 1 : 0,
        input.internalProbe.totalMs,
        input.internalProbe.connectMs,
        input.internalProbe.ttfbMs,
        input.internalProbe.statusCode,
        input.internalProbe.responseBytes,
        input.internalProbe.error,
        input.internalProbe.port,
        input.diagnosisCategory,
        input.diagnosisMessage,
        JSON.stringify(input.evidence.slice(0, 10))
      );

    pruneHistory(input.appId);

    const created = getDiagnosticById(Number(result.lastInsertRowid));
    if (!created) {
      throw new Error("Performance diagnostic run could not be loaded after saving");
    }
    return created;
  }

  function getDiagnosticById(id: number): StoredPerformanceDiagnostic | null {
    const row = db
      .prepare(`SELECT ${DIAGNOSTIC_COLUMNS} FROM app_performance_diagnostics WHERE id = ?`)
      .get(id) as unknown as DiagnosticRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Only ever applies to a run belonging to `appId` — the caller must have already verified ownership. */
  function attachBrowserDiagnostics(
    id: number,
    appId: number,
    input: BrowserDiagnosticsUpdateInput
  ): StoredPerformanceDiagnostic | null {
    db.prepare(
      `
        UPDATE app_performance_diagnostics
        SET
          browser_submitted_at = CURRENT_TIMESTAMP,
          browser_available = ?,
          browser_dns_ms = ?,
          browser_tls_ms = ?,
          browser_ttfb_ms = ?,
          browser_page_load_ms = ?,
          browser_total_navigation_ms = ?,
          browser_transfer_bytes = ?,
          resource_summary_json = ?,
          top_resources_json = ?,
          diagnosis_category = ?,
          diagnosis_message = ?,
          evidence_json = ?
        WHERE id = ? AND app_id = ?
      `
    ).run(
      input.available ? 1 : 0,
      input.dnsMs,
      input.tlsMs,
      input.ttfbMs,
      input.pageLoadMs,
      input.totalNavigationMs,
      input.transferBytes,
      JSON.stringify(input.resourceSummary ?? null),
      JSON.stringify(input.topResources ?? null),
      input.diagnosisCategory,
      input.diagnosisMessage,
      JSON.stringify(input.evidence.slice(0, 10)),
      id,
      appId
    );

    return getDiagnosticById(id);
  }

  function getLatestDiagnostic(appId: number): StoredPerformanceDiagnostic | null {
    const row = db
      .prepare(`SELECT ${DIAGNOSTIC_COLUMNS} FROM app_performance_diagnostics WHERE app_id = ? ORDER BY id DESC LIMIT 1`)
      .get(appId) as unknown as DiagnosticRow | undefined;
    return row ? mapRow(row) : null;
  }

  function listDiagnosticHistory(appId: number, limit = MAX_HISTORY_PER_APP): StoredPerformanceDiagnostic[] {
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_HISTORY_PER_APP);
    const rows = db
      .prepare(`SELECT ${DIAGNOSTIC_COLUMNS} FROM app_performance_diagnostics WHERE app_id = ? ORDER BY id DESC LIMIT ?`)
      .all(appId, boundedLimit) as unknown as DiagnosticRow[];
    return rows.map(mapRow);
  }

  /** Keeps at most MAX_HISTORY_PER_APP rows per app — deletes the oldest excess, never a full-table sweep. */
  function pruneHistory(appId: number): void {
    db.prepare(
      `
        DELETE FROM app_performance_diagnostics
        WHERE app_id = ?
          AND id NOT IN (
            SELECT id FROM app_performance_diagnostics
            WHERE app_id = ?
            ORDER BY id DESC
            LIMIT ?
          )
      `
    ).run(appId, appId, MAX_HISTORY_PER_APP);
  }

  return {
    createDiagnosticRun,
    getDiagnosticById,
    attachBrowserDiagnostics,
    getLatestDiagnostic,
    listDiagnosticHistory
  };
}

export type PerformanceDiagnosticsRepository = ReturnType<typeof createPerformanceDiagnosticsRepository>;
