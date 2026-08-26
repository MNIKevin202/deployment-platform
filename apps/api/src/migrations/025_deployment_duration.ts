import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration025DeploymentDuration: Migration = {
  version: 25,
  name: "deployment_duration",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE app_deployments
      ADD COLUMN duration_ms INTEGER;
    `);
  }
};
