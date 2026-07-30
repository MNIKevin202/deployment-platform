import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration018PlatformSettings: Migration = {
  version: 18,
  name: "platform_settings",
  up(db: DatabaseSync): void {
    // A simple key-value store for platform-wide settings that need to be
    // mutable at runtime (auto-backup config, image-prune config, deploy
    // notification config, an in-app admin-password override, …) rather than
    // baked into environment variables.
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
};
