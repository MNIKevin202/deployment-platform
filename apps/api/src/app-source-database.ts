import type { DatabaseSync } from "node:sqlite";

export type DeploymentMode = "prebuilt-image" | "dockerfile";

export type SourceValidationStatus = "unknown" | "valid" | "invalid";

export interface StoredAppSource {
  appId: number;
  provider: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryId: string | null;
  repositoryVisibility: string | null;
  branch: string;
  deploymentMode: DeploymentMode;
  dockerfilePath: string;
  buildContext: string;
  autoDeploy: boolean;
  lastValidatedCommitSha: string | null;
  lastValidatedAt: string | null;
  validationStatus: SourceValidationStatus;
  validationError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AppSourceRow {
  app_id: number;
  provider: string;
  repository_owner: string;
  repository_name: string;
  repository_id: string | null;
  repository_visibility: string | null;
  branch: string;
  deployment_mode: string;
  dockerfile_path: string;
  build_context: string;
  auto_deploy: number;
  last_validated_commit_sha: string | null;
  last_validated_at: string | null;
  validation_status: string;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
}

const APP_SOURCE_COLUMNS = `
  app_id, provider, repository_owner, repository_name, repository_id,
  repository_visibility, branch, deployment_mode, dockerfile_path,
  build_context, auto_deploy, last_validated_commit_sha, last_validated_at,
  validation_status, validation_error, created_at, updated_at
`;

function mapAppSource(row: AppSourceRow): StoredAppSource {
  return {
    appId: row.app_id,
    provider: row.provider,
    repositoryOwner: row.repository_owner,
    repositoryName: row.repository_name,
    repositoryId: row.repository_id,
    repositoryVisibility: row.repository_visibility,
    branch: row.branch,
    deploymentMode: row.deployment_mode as DeploymentMode,
    dockerfilePath: row.dockerfile_path,
    buildContext: row.build_context,
    autoDeploy: row.auto_deploy === 1,
    lastValidatedCommitSha: row.last_validated_commit_sha,
    lastValidatedAt: row.last_validated_at,
    validationStatus: row.validation_status as SourceValidationStatus,
    validationError: row.validation_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface UpsertAppSourceInput {
  provider: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryId: string | null;
  repositoryVisibility: string | null;
  branch: string;
  deploymentMode: DeploymentMode;
  dockerfilePath: string;
  buildContext: string;
  autoDeploy: boolean;
}

export interface UpdateAppSourceValidationInput {
  validationStatus: SourceValidationStatus;
  validationError: string | null;
  lastValidatedCommitSha: string | null;
  lastValidatedAt: string | null;
  /** Refreshed opportunistically whenever validation re-reads the repository. */
  repositoryVisibility?: string | null;
  repositoryId?: string | null;
}

export function createAppSourceRepository(db: DatabaseSync) {
  function getAppSource(appId: number): StoredAppSource | null {
    const row = db
      .prepare(`SELECT ${APP_SOURCE_COLUMNS} FROM app_sources WHERE app_id = ?`)
      .get(appId) as unknown as AppSourceRow | undefined;

    return row ? mapAppSource(row) : null;
  }

  /**
   * Creates the source link on first save, or replaces it in place. Any
   * config change (repository, branch, deployment mode, Dockerfile path,
   * build context) always resets validation back to "unknown" — a
   * previous validation result described the *old* configuration and
   * would misrepresent the new one. Callers are expected to immediately
   * run validation after this and persist the real result via
   * `updateAppSourceValidation`.
   */
  function upsertAppSource(appId: number, input: UpsertAppSourceInput): StoredAppSource {
    const existing = getAppSource(appId);

    if (existing) {
      db.prepare(
        `
          UPDATE app_sources
          SET
            provider = ?,
            repository_owner = ?,
            repository_name = ?,
            repository_id = ?,
            repository_visibility = ?,
            branch = ?,
            deployment_mode = ?,
            dockerfile_path = ?,
            build_context = ?,
            auto_deploy = ?,
            validation_status = 'unknown',
            validation_error = NULL,
            last_validated_commit_sha = NULL,
            last_validated_at = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE app_id = ?
        `
      ).run(
        input.provider,
        input.repositoryOwner,
        input.repositoryName,
        input.repositoryId,
        input.repositoryVisibility,
        input.branch,
        input.deploymentMode,
        input.dockerfilePath,
        input.buildContext,
        input.autoDeploy ? 1 : 0,
        appId
      );
    } else {
      db.prepare(
        `
          INSERT INTO app_sources (
            app_id, provider, repository_owner, repository_name,
            repository_id, repository_visibility, branch, deployment_mode,
            dockerfile_path, build_context, auto_deploy
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        appId,
        input.provider,
        input.repositoryOwner,
        input.repositoryName,
        input.repositoryId,
        input.repositoryVisibility,
        input.branch,
        input.deploymentMode,
        input.dockerfilePath,
        input.buildContext,
        input.autoDeploy ? 1 : 0
      );
    }

    const result = getAppSource(appId);

    if (!result) {
      throw new Error("App source configuration could not be loaded after saving");
    }

    return result;
  }

  function updateAppSourceValidation(
    appId: number,
    input: UpdateAppSourceValidationInput
  ): void {
    const existing = getAppSource(appId);

    if (!existing) {
      throw new Error("No source configuration is linked to this app");
    }

    db.prepare(
      `
        UPDATE app_sources
        SET
          validation_status = ?,
          validation_error = ?,
          last_validated_commit_sha = ?,
          last_validated_at = ?,
          repository_visibility = ?,
          repository_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE app_id = ?
      `
    ).run(
      input.validationStatus,
      input.validationError,
      input.lastValidatedCommitSha,
      input.lastValidatedAt,
      input.repositoryVisibility !== undefined
        ? input.repositoryVisibility
        : existing.repositoryVisibility,
      input.repositoryId !== undefined ? input.repositoryId : existing.repositoryId,
      appId
    );
  }

  function deleteAppSource(appId: number): void {
    db.prepare(`DELETE FROM app_sources WHERE app_id = ?`).run(appId);
  }

  return {
    getAppSource,
    upsertAppSource,
    updateAppSourceValidation,
    deleteAppSource
  };
}

export type AppSourceRepository = ReturnType<typeof createAppSourceRepository>;
