import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration007ProviderCredentials: Migration = {
  version: 7,
  name: "provider_credentials",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        authenticated_username TEXT,
        permissions_json TEXT,
        last_validated_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- One active credential per provider (e.g. one "github" row) — the
      -- table itself stays multi-provider-ready for later phases.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_credentials_provider
      ON provider_credentials(provider);
    `);
  }
};
