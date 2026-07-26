import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration004AppVolumes: Migration = {
  version: 4,
  name: "app_volumes",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_volumes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        volume_name TEXT NOT NULL UNIQUE,
        container_path TEXT NOT NULL,
        read_only INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(app_id, container_path)
      );

      CREATE INDEX IF NOT EXISTS idx_app_volumes_app_id
      ON app_volumes(app_id);
    `);
  }
};
