import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration009AppSourceDeploymentMetadata: Migration = {
  version: 9,
  name: "app_source_deployment_metadata",
  up(db: DatabaseSync): void {
    db.exec(`
      -- Additive only: existing rows keep their current validation-only
      -- behavior (deployment_mode/dockerfile_path/build_context from
      -- migration 008 are untouched). These columns describe an actual
      -- GitHub *deployment* rather than just source validation, so they
      -- default to NULL/safe values and only get populated once an app
      -- is actually deployed from GitHub via Phase 11.
      ALTER TABLE app_sources ADD COLUMN repository_full_name TEXT;
      ALTER TABLE app_sources ADD COLUMN repository_clone_url TEXT;
      ALTER TABLE app_sources ADD COLUMN subdirectory TEXT NOT NULL DEFAULT '.';
      ALTER TABLE app_sources ADD COLUMN build_strategy TEXT;
      ALTER TABLE app_sources ADD COLUMN detected_project_type TEXT;
      ALTER TABLE app_sources ADD COLUMN container_port INTEGER;
      ALTER TABLE app_sources ADD COLUMN latest_remote_commit_sha TEXT;
      ALTER TABLE app_sources ADD COLUMN latest_deployed_commit_sha TEXT;
      ALTER TABLE app_sources ADD COLUMN latest_deployed_commit_message TEXT;
      ALTER TABLE app_sources ADD COLUMN latest_deployed_at TEXT;

      CREATE TABLE IF NOT EXISTS github_deployment_locks (
        app_id INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL
      );
    `);
  }
};
