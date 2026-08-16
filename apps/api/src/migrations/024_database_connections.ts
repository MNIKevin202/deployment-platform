import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration024DatabaseConnections: Migration = {
  version: 24,
  name: "database_connections",
  up(db: DatabaseSync): void {
    // A registry of connection strings for databases hosted *elsewhere* —
    // MongoDB Atlas, a managed Postgres, an external Redis, and so on. Unlike
    // the app/global environment tables, this is not tied to any container the
    // platform runs; it is a place to keep, reveal, and copy the strings, and
    // to push one into the global environment so every app inherits it.
    //
    // `env_key` is the variable name a connection is exposed as when pushed to
    // the global environment (e.g. MONGODB_URI). It is optional: a connection
    // can exist purely to be copied by hand.
    db.exec(`
      CREATE TABLE IF NOT EXISTS database_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'mongodb',
        connection_string TEXT NOT NULL,
        env_key TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
};
