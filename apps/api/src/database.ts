import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath =
  process.env.DATABASE_PATH ??
  "/data/deployment-platform.sqlite";

mkdirSync(dirname(databasePath), {
  recursive: true
});

export const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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

export interface StoredApp {
  id: number;
  name: string;
  containerId: string | null;
  image: string;
  containerPort: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface AppRow {
  id: number;
  name: string;
  container_id: string | null;
  image: string;
  container_port: number;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapApp(row: AppRow): StoredApp {
  return {
    id: row.id,
    name: row.name,
    containerId: row.container_id,
    image: row.image,
    containerPort: row.container_port,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listStoredApps(): StoredApp[] {
  const rows = database
    .prepare(`
      SELECT
        id,
        name,
        container_id,
        image,
        container_port,
        status,
        created_at,
        updated_at
      FROM apps
      ORDER BY created_at DESC
    `)
    .all() as unknown as AppRow[];

  return rows.map(mapApp);
}

export function getStoredAppByName(
  name: string
): StoredApp | null {
  const row = database
    .prepare(`
      SELECT
        id,
        name,
        container_id,
        image,
        container_port,
        status,
        created_at,
        updated_at
      FROM apps
      WHERE name = ?
    `)
    .get(name) as unknown as AppRow | undefined;

  return row ? mapApp(row) : null;
}

export function createStoredApp(input: {
  name: string;
  image: string;
  containerPort: number;
}): StoredApp {
  database
    .prepare(`
      INSERT INTO apps (
        name,
        image,
        container_port,
        status
      )
      VALUES (?, ?, ?, 'created')
    `)
    .run(
      input.name,
      input.image,
      input.containerPort
    );

  const app = getStoredAppByName(input.name);

  if (!app) {
    throw new Error("Stored app could not be loaded after creation");
  }

  return app;
}

export function updateStoredAppContainer(input: {
  name: string;
  containerId: string;
  status: string;
}): void {
  database
    .prepare(`
      UPDATE apps
      SET
        container_id = ?,
        status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE name = ?
    `)
    .run(
      input.containerId,
      input.status,
      input.name
    );
}

export function updateStoredAppStatus(
  name: string,
  status: string
): void {
  database
    .prepare(`
      UPDATE apps
      SET
        status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE name = ?
    `)
    .run(status, name);
}

export function deleteStoredApp(name: string): void {
  database
    .prepare(`
      DELETE FROM apps
      WHERE name = ?
    `)
    .run(name);
}
