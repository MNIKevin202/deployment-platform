import type { DatabaseSync } from "node:sqlite";

export interface StoredGithubAppInstallation {
  id: number;
  installationId: number;
  appId: number;
  accountLogin: string;
  accountId: number;
  accountType: string;
  targetType: string;
  repositorySelection: string;
  connectedByUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InstallationRow {
  id: number;
  installation_id: number;
  app_id: number;
  account_login: string;
  account_id: number;
  account_type: string;
  target_type: string;
  repository_selection: string;
  connected_by_username: string | null;
  created_at: string;
  updated_at: string;
}

const INSTALLATION_COLUMNS = `
  id, installation_id, app_id, account_login, account_id, account_type,
  target_type, repository_selection, connected_by_username, created_at, updated_at
`;

function mapInstallation(row: InstallationRow): StoredGithubAppInstallation {
  return {
    id: row.id,
    installationId: row.installation_id,
    appId: row.app_id,
    accountLogin: row.account_login,
    accountId: row.account_id,
    accountType: row.account_type,
    targetType: row.target_type,
    repositorySelection: row.repository_selection,
    connectedByUsername: row.connected_by_username,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface UpsertGithubAppInstallationInput {
  installationId: number;
  appId: number;
  accountLogin: string;
  accountId: number;
  accountType: string;
  targetType: string;
  repositorySelection: string;
  connectedByUsername: string | null;
}

export function createInstallationRepository(db: DatabaseSync) {
  function listGithubAppInstallations(): StoredGithubAppInstallation[] {
    const rows = db
      .prepare(`SELECT ${INSTALLATION_COLUMNS} FROM github_app_installations ORDER BY created_at DESC`)
      .all() as unknown as InstallationRow[];

    return rows.map(mapInstallation);
  }

  function getGithubAppInstallation(installationId: number): StoredGithubAppInstallation | null {
    const row = db
      .prepare(`SELECT ${INSTALLATION_COLUMNS} FROM github_app_installations WHERE installation_id = ?`)
      .get(installationId) as unknown as InstallationRow | undefined;

    return row ? mapInstallation(row) : null;
  }

  /** One row per installation id — a re-authorization of the same installation updates it in place. */
  function upsertGithubAppInstallation(
    input: UpsertGithubAppInstallationInput
  ): StoredGithubAppInstallation {
    const existing = getGithubAppInstallation(input.installationId);

    if (existing) {
      db.prepare(
        `
          UPDATE github_app_installations
          SET
            app_id = ?,
            account_login = ?,
            account_id = ?,
            account_type = ?,
            target_type = ?,
            repository_selection = ?,
            connected_by_username = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE installation_id = ?
        `
      ).run(
        input.appId,
        input.accountLogin,
        input.accountId,
        input.accountType,
        input.targetType,
        input.repositorySelection,
        input.connectedByUsername,
        input.installationId
      );
    } else {
      db.prepare(
        `
          INSERT INTO github_app_installations (
            installation_id, app_id, account_login, account_id, account_type,
            target_type, repository_selection, connected_by_username
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        input.installationId,
        input.appId,
        input.accountLogin,
        input.accountId,
        input.accountType,
        input.targetType,
        input.repositorySelection,
        input.connectedByUsername
      );
    }

    const result = getGithubAppInstallation(input.installationId);

    if (!result) {
      throw new Error("GitHub App installation could not be loaded after saving");
    }

    return result;
  }

  function deleteGithubAppInstallation(installationId: number): void {
    db.prepare(`DELETE FROM github_app_installations WHERE installation_id = ?`).run(installationId);
  }

  return {
    listGithubAppInstallations,
    getGithubAppInstallation,
    upsertGithubAppInstallation,
    deleteGithubAppInstallation
  };
}

export type InstallationRepository = ReturnType<typeof createInstallationRepository>;
