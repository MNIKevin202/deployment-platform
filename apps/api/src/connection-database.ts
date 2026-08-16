import type { DatabaseSync } from "node:sqlite";

export type DatabaseConnectionKind =
  | "mongodb"
  | "postgres"
  | "mysql"
  | "redis"
  | "sqlite"
  | "other";

export interface StoredDatabaseConnection {
  id: number;
  name: string;
  kind: DatabaseConnectionKind;
  connectionString: string;
  /** Variable name used when this connection is pushed to the global
   * environment (e.g. MONGODB_URI). Null when the connection is copy-only. */
  envKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDatabaseConnectionInput {
  name: string;
  kind: DatabaseConnectionKind;
  connectionString: string;
  envKey: string | null;
}

export interface UpdateDatabaseConnectionInput {
  name?: string;
  kind?: DatabaseConnectionKind;
  connectionString?: string;
  envKey?: string | null;
}

interface DatabaseConnectionRow {
  id: number;
  name: string;
  kind: string;
  connection_string: string;
  env_key: string | null;
  created_at: string;
  updated_at: string;
}

function mapConnection(row: DatabaseConnectionRow): StoredDatabaseConnection {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DatabaseConnectionKind,
    connectionString: row.connection_string,
    envKey: row.env_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const COLUMNS = `
  id, name, kind, connection_string, env_key, created_at, updated_at
`;

export function createConnectionRepository(db: DatabaseSync) {
  function listConnections(): StoredDatabaseConnection[] {
    const rows = db
      .prepare(
        `SELECT ${COLUMNS} FROM database_connections ORDER BY name COLLATE NOCASE ASC, id ASC`
      )
      .all() as unknown as DatabaseConnectionRow[];

    return rows.map(mapConnection);
  }

  function getConnectionById(id: number): StoredDatabaseConnection | null {
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM database_connections WHERE id = ?`)
      .get(id) as unknown as DatabaseConnectionRow | undefined;

    return row ? mapConnection(row) : null;
  }

  function createConnection(
    input: CreateDatabaseConnectionInput
  ): StoredDatabaseConnection {
    const result = db
      .prepare(
        `
          INSERT INTO database_connections (name, kind, connection_string, env_key)
          VALUES (?, ?, ?, ?)
        `
      )
      .run(input.name, input.kind, input.connectionString, input.envKey);

    const created = getConnectionById(Number(result.lastInsertRowid));

    if (!created) {
      throw new Error("Database connection could not be loaded after creation");
    }

    return created;
  }

  function updateConnection(
    id: number,
    input: UpdateDatabaseConnectionInput
  ): void {
    const existing = getConnectionById(id);

    if (!existing) {
      throw new Error("Database connection not found");
    }

    db.prepare(
      `
        UPDATE database_connections
        SET name = ?, kind = ?, connection_string = ?, env_key = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(
      input.name ?? existing.name,
      input.kind ?? existing.kind,
      input.connectionString ?? existing.connectionString,
      // env_key is nullable, so `undefined` means "leave as-is" while an
      // explicit `null` clears it.
      input.envKey === undefined ? existing.envKey : input.envKey,
      id
    );
  }

  function deleteConnection(id: number): void {
    db.prepare(`DELETE FROM database_connections WHERE id = ?`).run(id);
  }

  return {
    listConnections,
    getConnectionById,
    createConnection,
    updateConnection,
    deleteConnection
  };
}

export type ConnectionRepository = ReturnType<typeof createConnectionRepository>;
