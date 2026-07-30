import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration019AppResourceLimits: Migration = {
  version: 19,
  name: "app_resource_limits",
  up(db: DatabaseSync): void {
    // Optional per-app resource caps, applied to the container's HostConfig
    // on create/redeploy. NULL means "no limit" — the pre-existing behavior —
    // so this is fully additive and never suddenly constrains an app.
    //  - memory_limit_mb: hard memory cap in MiB (swap is pinned to the same
    //    value so the app can't exceed it via swap).
    //  - cpu_limit: CPU cores (fractional allowed, e.g. 0.5), mapped to
    //    Docker NanoCpus.
    db.exec(`
      ALTER TABLE apps ADD COLUMN memory_limit_mb INTEGER;
      ALTER TABLE apps ADD COLUMN cpu_limit REAL;
    `);
  }
};
