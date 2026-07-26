import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration008AppSources: Migration = {
  version: 8,
  name: "app_sources",
  up(db: DatabaseSync): void {
    db.exec(`
      -- One row per app (app_id is the primary key) enforces "one source
      -- configuration per app" at the schema level, matching the
      -- app_health_checks pattern from migration 005. Deliberately no
      -- foreign key to provider_credentials — deleting a GitHub credential
      -- must never cascade-delete this preparatory metadata; the two are
      -- only ever joined logically by matching "provider" at query time.
      CREATE TABLE IF NOT EXISTS app_sources (
        app_id INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        repository_owner TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        repository_id TEXT,
        repository_visibility TEXT,
        branch TEXT NOT NULL,
        deployment_mode TEXT NOT NULL DEFAULT 'prebuilt-image',
        dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
        build_context TEXT NOT NULL DEFAULT '.',
        auto_deploy INTEGER NOT NULL DEFAULT 0,
        last_validated_commit_sha TEXT,
        last_validated_at TEXT,
        validation_status TEXT NOT NULL DEFAULT 'unknown',
        validation_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_sources_repository
      ON app_sources(repository_owner, repository_name);

      CREATE INDEX IF NOT EXISTS idx_app_sources_provider
      ON app_sources(provider);
    `);
  }
};
