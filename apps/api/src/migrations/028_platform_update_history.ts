import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration028PlatformUpdateHistory: Migration = {
  version: 28,
  name: "platform_update_history",
  risk: "expand",
  up(db: DatabaseSync): void {
    // Durable, append-only record of every platform self-update attempt —
    // the data behind the Updates UI's history list. Written by the host
    // updater (via the same docker-exec-into-the-API pattern the existing
    // updater uses to read the GitHub token) at the start and end of each
    // attempt. Deliberately NOT tied to any app row: this is the platform
    // updating itself, unrelated to the apps it hosts. Nothing here ever
    // holds a secret — only versions, channels, states, timestamps, and a
    // short redacted diagnostic string.
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_update_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_version TEXT,
        to_version TEXT NOT NULL,
        channel TEXT NOT NULL,
        policy TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        result TEXT NOT NULL,
        failure_stage TEXT,
        health_result TEXT,
        rollback_attempted INTEGER NOT NULL DEFAULT 0,
        rollback_result TEXT,
        diagnostic TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_platform_update_history_started
        ON platform_update_history (id DESC);
    `);
  }
};
