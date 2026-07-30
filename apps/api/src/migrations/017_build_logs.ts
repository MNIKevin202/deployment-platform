import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration017BuildLogs: Migration = {
  version: 17,
  name: "build_logs",
  up(db: DatabaseSync): void {
    // Capture the output of the most recent image build per GitHub-sourced
    // app so the panel's Logs tab can show *build* logs (what happened while
    // building the image), distinct from the Console tab's live *runtime*
    // output. Additive and nullable — existing apps simply have no build log
    // recorded until their next deploy.
    //
    //  - last_build_status: "success" | "failed" | "reused"
    //    ("reused" = an already-built image for that commit was reused, so
    //     no new build ran).
    db.exec(`
      ALTER TABLE app_sources ADD COLUMN last_build_log TEXT;
      ALTER TABLE app_sources ADD COLUMN last_build_log_truncated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE app_sources ADD COLUMN last_build_status TEXT;
      ALTER TABLE app_sources ADD COLUMN last_build_at TEXT;
    `);
  }
};
