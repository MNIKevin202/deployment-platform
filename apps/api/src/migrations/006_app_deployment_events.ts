import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration006AppDeploymentEvents: Migration = {
  version: 6,
  name: "app_deployment_events",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_deployment_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_deployment_events_app_created
      ON app_deployment_events(app_id, id DESC);
    `);
  }
};
