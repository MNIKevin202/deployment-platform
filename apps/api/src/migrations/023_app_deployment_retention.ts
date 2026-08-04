import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration023AppDeploymentRetention: Migration = {
  version: 23,
  name: "app_deployment_retention",
  up(db: DatabaseSync): void {
    // Optional per-app override for how many recent rollback versions to keep.
    // NULL (the default for every existing and new app) means "use the global
    // deployment_retention setting", so this is fully additive and changes no
    // app's behavior until an operator explicitly sets an override — exactly
    // like the per-app resource caps added in migration 019.
    db.exec(`
      ALTER TABLE apps ADD COLUMN deployment_retention INTEGER;
    `);
  }
};
