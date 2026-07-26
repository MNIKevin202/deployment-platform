import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration005AppHealthChecks: Migration = {
  version: 5,
  name: "app_health_checks",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_health_checks (
        app_id INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        path TEXT NOT NULL DEFAULT '/health',
        expected_status INTEGER NOT NULL DEFAULT 200,
        interval_seconds INTEGER NOT NULL DEFAULT 30,
        timeout_seconds INTEGER NOT NULL DEFAULT 5,
        failure_threshold INTEGER NOT NULL DEFAULT 3,
        success_threshold INTEGER NOT NULL DEFAULT 2,
        state TEXT NOT NULL DEFAULT 'disabled',
        last_checked_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_status_code INTEGER,
        last_latency_ms INTEGER,
        consecutive_successes INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_health_checks_enabled
      ON app_health_checks(enabled);

      CREATE INDEX IF NOT EXISTS idx_app_health_checks_state
      ON app_health_checks(state);
    `);
  }
};
