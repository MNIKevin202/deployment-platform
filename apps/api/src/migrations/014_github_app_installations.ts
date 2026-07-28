import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

/**
 * GitHub App installation metadata — the automated replacement for the
 * manual personal-access-token flow (provider_credentials, migration 007,
 * which is preserved unchanged for the "advanced fallback" path).
 *
 * Deliberately does NOT store installation access tokens: those are
 * short-lived (~1 hour), minted on demand from the app's private key
 * (GITHUB_APP_PRIVATE_KEY, an environment/mounted-file secret, never a
 * database value) and used immediately, never persisted anywhere. What IS
 * persisted here is only what's needed to know an installation exists and
 * mint a fresh token for it later: the installation id GitHub assigned,
 * which account it's installed on, and a repository-selection summary for
 * the UI.
 */
export const migration014GithubAppInstallations: Migration = {
  version: 14,
  name: "github_app_installations",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_app_installations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id INTEGER NOT NULL,
        app_id INTEGER NOT NULL,
        account_login TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        account_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        repository_selection TEXT NOT NULL,
        connected_by_username TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_github_app_installations_installation_id
      ON github_app_installations(installation_id);
    `);
  }
};
