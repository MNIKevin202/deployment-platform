import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration001InitialSchema: Migration = {
  version: 1,
  name: "initial_schema",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        container_id TEXT,
        image TEXT NOT NULL,
        container_port INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_apps_name
      ON apps(name);

      CREATE INDEX IF NOT EXISTS idx_apps_container_id
      ON apps(container_id);
    `);
  }
};
