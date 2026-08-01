import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration021CronJobs: Migration = {
  version: 21,
  name: "cron_jobs",
  up(db: DatabaseSync): void {
    // Scheduled shell commands run inside a managed app's own container via
    // `docker exec`. Bound to an app (ON DELETE CASCADE) so removing the app
    // removes its jobs — a job can never outlive the container it targets.
    // The last-run columns mirror the build-log-on-source pattern: a single
    // most-recent result is stored inline rather than a separate history
    // table, which is enough to answer "did it run, and did it work?".
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        command TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        timeout_seconds INTEGER NOT NULL DEFAULT 300,
        last_run_at TEXT,
        last_status TEXT,
        last_exit_code INTEGER,
        last_output TEXT,
        last_duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_cron_jobs_app_id ON cron_jobs (app_id);
    `);
  }
};
