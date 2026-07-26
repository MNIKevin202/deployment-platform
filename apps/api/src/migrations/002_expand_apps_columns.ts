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

const columnsToAdd: Array<[name: string, definition: string]> = [
  ["container_name", "TEXT"],
  ["domain", "TEXT"],
  ["desired_status", "TEXT NOT NULL DEFAULT 'running'"],
  ["restart_policy", "TEXT NOT NULL DEFAULT 'unless-stopped'"],
  ["last_deployed_at", "TEXT"]
];

export const migration002ExpandAppsColumns: Migration = {
  version: 2,
  name: "expand_apps_columns",
  up(db: DatabaseSync): void {
    for (const [name, definition] of columnsToAdd) {
      if (!columnExists(db, "apps", name)) {
        db.exec(`ALTER TABLE apps ADD COLUMN ${name} ${definition}`);
      }
    }

    db.exec(`
      UPDATE apps
      SET container_name = 'app-' || name
      WHERE container_name IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_domain
      ON apps(domain)
      WHERE domain IS NOT NULL;
    `);
  }
};
