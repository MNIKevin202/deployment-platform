import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration016AppDeployments: Migration = {
  version: 16,
  name: "app_deployments",
  up(db: DatabaseSync): void {
    // A per-app deployment ledger: one row per released version, in the
    // CapRover mould. Distinct from app_deployment_events (a noisy,
    // append-only diagnostic log): this is the clean "Version History"
    // that the panel lists and that a revert re-runs.
    //
    //  - `version` is monotonic per app (1, 2, 3, …), never reused.
    //  - `image_tag` is the exact image that was run. For GitHub builds it
    //    is the retained `deployment-app-<id>:<shortSha>` image, so a
    //    revert can re-run a past version with no rebuild.
    //  - `source_kind` gates revert: only "github" versions have retained,
    //    per-commit images to roll back to; "image" apps (plain Docker
    //    images, databases) get a current-only history with no revert.
    //  - `is_current` marks the single active version. Exactly one row per
    //    app has is_current = 1 at any time.
    //  - `revert_of_version` records that this version was produced by
    //    reverting to an earlier one (CapRover-style: a revert appends a
    //    new version rather than mutating history).
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        image_tag TEXT NOT NULL,
        commit_sha TEXT,
        commit_message TEXT,
        source_kind TEXT NOT NULL DEFAULT 'image',
        revert_of_version INTEGER,
        is_current INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_app_deployments_app_version
      ON app_deployments(app_id, version);

      CREATE INDEX IF NOT EXISTS idx_app_deployments_app_version
      ON app_deployments(app_id, version DESC);
    `);

    // Seed a single "current" version per existing app so the History tab
    // is populated on day one rather than only after the next deploy. For
    // a GitHub app the running image is the retained build for its last
    // deployed commit, so derive the tag from that commit; otherwise the
    // app runs its stored image directly.
    db.exec(`
      INSERT INTO app_deployments (
        app_id, version, image_tag, commit_sha, commit_message, source_kind, is_current, created_at
      )
      SELECT
        a.id,
        1,
        CASE
          WHEN s.latest_deployed_commit_sha IS NOT NULL
            THEN 'deployment-app-' || a.id || ':' || substr(s.latest_deployed_commit_sha, 1, 12)
          ELSE a.image
        END,
        s.latest_deployed_commit_sha,
        s.latest_deployed_commit_message,
        CASE WHEN s.app_id IS NOT NULL THEN 'github' ELSE 'image' END,
        1,
        COALESCE(s.latest_deployed_at, a.last_deployed_at, a.created_at, CURRENT_TIMESTAMP)
      FROM apps a
      LEFT JOIN app_sources s ON s.app_id = a.id;
    `);
  }
};
