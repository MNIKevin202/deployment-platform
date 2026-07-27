import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration011PerformanceDiagnostics: Migration = {
  version: 11,
  name: "performance_diagnostics",
  up(db: DatabaseSync): void {
    db.exec(`
      -- One row per "Run Performance Test" click. Browser timing is
      -- merged in via a second write once the browser finishes its own
      -- measurement (browser_submitted_at is NULL until then). Bounded
      -- to the latest 20 rows per app by the repository layer, not by a
      -- DB-level trigger, so retention logic stays in one place
      -- (performance-diagnostics-database.ts), same as this project's
      -- existing event/backup retention approach.
      CREATE TABLE IF NOT EXISTS app_performance_diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

        public_ok INTEGER NOT NULL,
        public_total_ms INTEGER,
        public_dns_ms INTEGER,
        public_connect_ms INTEGER,
        public_tls_ms INTEGER,
        public_ttfb_ms INTEGER,
        public_download_ms INTEGER,
        public_status_code INTEGER,
        public_response_bytes INTEGER,
        public_redirect_count INTEGER NOT NULL DEFAULT 0,
        public_final_host TEXT,
        public_error TEXT,

        internal_ok INTEGER NOT NULL,
        internal_total_ms INTEGER,
        internal_connect_ms INTEGER,
        internal_ttfb_ms INTEGER,
        internal_status_code INTEGER,
        internal_response_bytes INTEGER,
        internal_error TEXT,
        internal_port INTEGER,

        browser_submitted_at TEXT,
        browser_available INTEGER NOT NULL DEFAULT 0,
        browser_dns_ms INTEGER,
        browser_tls_ms INTEGER,
        browser_ttfb_ms INTEGER,
        browser_page_load_ms INTEGER,
        browser_total_navigation_ms INTEGER,
        browser_transfer_bytes INTEGER,

        -- Small, bounded JSON blobs only — never raw HTML/response
        -- bodies, never full URLs with query strings, never tokens.
        resource_summary_json TEXT,
        top_resources_json TEXT,

        diagnosis_category TEXT,
        diagnosis_message TEXT,
        evidence_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_app_performance_diagnostics_app_id
        ON app_performance_diagnostics (app_id, id DESC);
    `);
  }
};
