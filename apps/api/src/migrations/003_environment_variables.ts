import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

interface TableInfoRow {
  name: string;
}

function columnExists(
  db: DatabaseSync,
  table: string,
  column: string
): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as TableInfoRow[];

  return rows.some((row) => row.name === column);
}

export const migration003EnvironmentVariables: Migration = {
  version: 3,
  name: "environment_variables",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS global_environment_variables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        is_secret INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_environment_variables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        is_secret INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(app_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_app_environment_variables_app_id
      ON app_environment_variables(app_id);
    `);

    // Lets the API tell whether an app's running container reflects the
    // latest environment variables, without inspecting the live container.
    if (!columnExists(db, "apps", "environment_touched_at")) {
      db.exec(`ALTER TABLE apps ADD COLUMN environment_touched_at TEXT`);
    }
  }
};
