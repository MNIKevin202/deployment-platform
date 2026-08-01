import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration022CronJobRuns: Migration = {
  version: 22,
  name: "cron_job_runs",
  up(db: DatabaseSync): void {
    // A full run history for each cron job. The cron_jobs table keeps the
    // most-recent result inline (for the list view without a join); this
    // table records every run so the operator can answer "did it run every
    // night last week, and which nights failed?". Bound to the job with
    // ON DELETE CASCADE so a job's history is removed with the job — and,
    // since cron_jobs itself cascades from apps, deleting an app clears the
    // whole chain.
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_job_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cron_job_id INTEGER NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        exit_code INTEGER,
        output TEXT,
        duration_ms INTEGER NOT NULL,
        ran_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_cron_job_runs_job_id
        ON cron_job_runs (cron_job_id, id DESC);
    `);
  }
};
