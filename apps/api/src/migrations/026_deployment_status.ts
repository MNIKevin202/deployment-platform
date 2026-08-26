import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration026DeploymentStatus: Migration = {
  version: 26,
  name: "deployment_status",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE app_deployments
      ADD COLUMN status TEXT NOT NULL DEFAULT 'success';
    `);
  }
};
