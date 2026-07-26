import type { DatabaseSync } from "node:sqlite";
import { migration001InitialSchema } from "./001_initial_schema.js";
import { migration002ExpandAppsColumns } from "./002_expand_apps_columns.js";
import { migration003EnvironmentVariables } from "./003_environment_variables.js";
import { migration004AppVolumes } from "./004_app_volumes.js";
import type { Migration } from "./types.js";

export type { Migration } from "./types.js";

const migrations: Migration[] = [
  migration001InitialSchema,
  migration002ExpandAppsColumns,
  migration003EnvironmentVariables,
  migration004AppVolumes
];

interface SchemaMigrationRow {
  version: number;
}

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedVersions = new Set(
    (
      db
        .prepare("SELECT version FROM schema_migrations")
        .all() as unknown as SchemaMigrationRow[]
    ).map((row) => row.version)
  );

  const orderedMigrations = [...migrations].sort(
    (a, b) => a.version - b.version
  );

  for (const migration of orderedMigrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    db.exec("BEGIN");

    try {
      migration.up(db);

      db.prepare(
        "INSERT INTO schema_migrations (version, name) VALUES (?, ?)"
      ).run(migration.version, migration.name);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
