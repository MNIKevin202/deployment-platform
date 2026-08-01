import type { DatabaseSync } from "node:sqlite";

export type DeploymentMode = "prebuilt-image" | "dockerfile";

export type SourceValidationStatus = "unknown" | "valid" | "invalid";

/**
 * "dockerfile"/"nodejs"/"static" are the strategies this phase can
 * actually build and deploy. "unsupported" means inspection identified a
 * project (e.g. Docker Compose) that is deliberately not deployable yet
 * — stored so the UI can explain why, rather than silently refusing.
 */
export type BuildStrategy = "dockerfile" | "nodejs" | "static" | "unsupported";

/** The subset of BuildStrategy an operator can actually choose — "unsupported" is only ever a detection result, never a request. */
export type SelectableBuildStrategy = Exclude<BuildStrategy, "unsupported">;

export interface StoredAppSource {
  appId: number;
  provider: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string | null;
  repositoryId: string | null;
  repositoryVisibility: string | null;
  repositoryCloneUrl: string | null;
  branch: string;
  subdirectory: string;
  deploymentMode: DeploymentMode;
  dockerfilePath: string;
  buildContext: string;
  buildStrategy: BuildStrategy | null;
  /**
   * The operator's own explicit strategy choice — null means "follow
   * whatever inspection recommends" (the default, unchanged behavior).
   * Deliberately a separate column from buildStrategy (which is
   * DISPLAY-ONLY and overwritten by every inspection run): an
   * inspection rerun must never silently clobber a manual override, and
   * this is what makes that possible.
   */
  selectedStrategy: SelectableBuildStrategy | null;
  detectedProjectType: string | null;
  containerPort: number | null;
  /** "manual" when the operator typed it themselves, or the PortDetectionSource that was accepted. Null before any port has ever been confirmed. */
  containerPortSource: string | null;
  containerPortConfidence: string | null;
  autoDeploy: boolean;
  lastValidatedCommitSha: string | null;
  lastValidatedAt: string | null;
  validationStatus: SourceValidationStatus;
  validationError: string | null;
  latestRemoteCommitSha: string | null;
  latestDeployedCommitSha: string | null;
  latestDeployedCommitMessage: string | null;
  latestDeployedAt: string | null;
  /** Most recent GitHub-deployment runtime verification results — see github-deploy-service.ts. */
  lastInternalHealthResult: string | null;
  lastPublicHealthResult: string | null;
  lastDeploymentStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AppSourceRow {
  app_id: number;
  provider: string;
  repository_owner: string;
  repository_name: string;
  repository_full_name: string | null;
  repository_id: string | null;
  repository_visibility: string | null;
  repository_clone_url: string | null;
  branch: string;
  subdirectory: string;
  deployment_mode: string;
  dockerfile_path: string;
  build_context: string;
  build_strategy: string | null;
  selected_strategy: string | null;
  detected_project_type: string | null;
  container_port: number | null;
  container_port_source: string | null;
  container_port_confidence: string | null;
  auto_deploy: number;
  last_validated_commit_sha: string | null;
  last_validated_at: string | null;
  validation_status: string;
  validation_error: string | null;
  latest_remote_commit_sha: string | null;
  latest_deployed_commit_sha: string | null;
  latest_deployed_commit_message: string | null;
  latest_deployed_at: string | null;
  last_internal_health_result: string | null;
  last_public_health_result: string | null;
  last_deployment_status: string | null;
  created_at: string;
  updated_at: string;
}

const APP_SOURCE_COLUMNS = `
  app_id, provider, repository_owner, repository_name, repository_full_name,
  repository_id, repository_visibility, repository_clone_url, branch,
  subdirectory, deployment_mode, dockerfile_path, build_context,
  build_strategy, selected_strategy, detected_project_type, container_port, container_port_source,
  container_port_confidence, auto_deploy,
  last_validated_commit_sha, last_validated_at, validation_status,
  validation_error, latest_remote_commit_sha, latest_deployed_commit_sha,
  latest_deployed_commit_message, latest_deployed_at, last_internal_health_result,
  last_public_health_result, last_deployment_status, created_at, updated_at
`;

function mapAppSource(row: AppSourceRow): StoredAppSource {
  return {
    appId: row.app_id,
    provider: row.provider,
    repositoryOwner: row.repository_owner,
    repositoryName: row.repository_name,
    repositoryFullName: row.repository_full_name,
    repositoryId: row.repository_id,
    repositoryVisibility: row.repository_visibility,
    repositoryCloneUrl: row.repository_clone_url,
    branch: row.branch,
    subdirectory: row.subdirectory,
    deploymentMode: row.deployment_mode as DeploymentMode,
    dockerfilePath: row.dockerfile_path,
    buildContext: row.build_context,
    buildStrategy: (row.build_strategy as BuildStrategy | null) ?? null,
    selectedStrategy: (row.selected_strategy as SelectableBuildStrategy | null) ?? null,
    detectedProjectType: row.detected_project_type,
    containerPort: row.container_port,
    containerPortSource: row.container_port_source,
    containerPortConfidence: row.container_port_confidence,
    autoDeploy: row.auto_deploy === 1,
    lastValidatedCommitSha: row.last_validated_commit_sha,
    lastValidatedAt: row.last_validated_at,
    validationStatus: row.validation_status as SourceValidationStatus,
    validationError: row.validation_error,
    latestRemoteCommitSha: row.latest_remote_commit_sha,
    latestDeployedCommitSha: row.latest_deployed_commit_sha,
    latestDeployedCommitMessage: row.latest_deployed_commit_message,
    latestDeployedAt: row.latest_deployed_at,
    lastInternalHealthResult: row.last_internal_health_result,
    lastPublicHealthResult: row.last_public_health_result,
    lastDeploymentStatus: row.last_deployment_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface UpsertAppSourceInput {
  provider: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string | null;
  repositoryId: string | null;
  repositoryVisibility: string | null;
  repositoryCloneUrl: string | null;
  branch: string;
  subdirectory: string;
  deploymentMode: DeploymentMode;
  dockerfilePath: string;
  buildContext: string;
  /** The operator's explicit strategy choice — null/omitted to follow the inspection recommendation automatically. */
  selectedStrategy?: SelectableBuildStrategy | null;
  containerPort: number | null;
  /** "manual" when the operator typed it, or the accepted PortDetectionSource. Null if not confirmed. */
  containerPortSource?: string | null;
  containerPortConfidence?: string | null;
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

export interface UpdateInspectionResultInput {
  buildStrategy: BuildStrategy;
  detectedProjectType: string;
  latestRemoteCommitSha: string | null;
}

export interface UpdateDeployedCommitInput {
  commitSha: string;
  commitMessage: string | null;
  deployedAt: string;
}

export function createAppSourceRepository(db: DatabaseSync) {
  function getAppSource(appId: number): StoredAppSource | null {
    const row = db
      .prepare(`SELECT ${APP_SOURCE_COLUMNS} FROM app_sources WHERE app_id = ?`)
      .get(appId) as unknown as AppSourceRow | undefined;

    return row ? mapAppSource(row) : null;
  }

  /**
   * Creates the source link on first save, or replaces it in place.
   * Only a change to an *inspection-relevant* field — repository,
   * branch, subdirectory, Dockerfile path, or build context — resets
   * validation and inspection back to "unknown"/null; a previous result
   * described the *old* configuration in that case and would
   * misrepresent the new one. Changing only the confirmed container
   * port (or its source/confidence) deliberately does NOT invalidate an
   * existing inspection — the operator correcting a port after a
   * successful inspection shouldn't be forced to re-inspect first.
   * Callers are expected to immediately run validation/inspection after
   * an inspection-relevant change. Deployment history (latest_deployed_*)
   * is deliberately left alone either way — editing configuration doesn't
   * erase what's already running.
   */
  function upsertAppSource(appId: number, input: UpsertAppSourceInput): StoredAppSource {
    const existing = getAppSource(appId);
    const selectedStrategy = input.selectedStrategy ?? null;

    const inspectionRelevantChanged =
      !existing ||
      existing.repositoryOwner !== input.repositoryOwner ||
      existing.repositoryName !== input.repositoryName ||
      existing.branch !== input.branch ||
      existing.subdirectory !== input.subdirectory ||
      existing.dockerfilePath !== input.dockerfilePath ||
      existing.buildContext !== input.buildContext ||
      existing.selectedStrategy !== selectedStrategy;

    const containerPortSource = input.containerPortSource ?? null;
    const containerPortConfidence = input.containerPortConfidence ?? null;

    if (existing) {
      if (inspectionRelevantChanged) {
        db.prepare(
          `
            UPDATE app_sources
            SET
              provider = ?,
              repository_owner = ?,
              repository_name = ?,
              repository_full_name = ?,
              repository_id = ?,
              repository_visibility = ?,
              repository_clone_url = ?,
              branch = ?,
              subdirectory = ?,
              deployment_mode = ?,
              dockerfile_path = ?,
              build_context = ?,
              container_port = ?,
              container_port_source = ?,
              container_port_confidence = ?,
              auto_deploy = ?,
              selected_strategy = ?,
              build_strategy = NULL,
              detected_project_type = NULL,
              latest_remote_commit_sha = NULL,
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
          input.repositoryFullName,
          input.repositoryId,
          input.repositoryVisibility,
          input.repositoryCloneUrl,
          input.branch,
          input.subdirectory,
          input.deploymentMode,
          input.dockerfilePath,
          input.buildContext,
          input.containerPort,
          containerPortSource,
          containerPortConfidence,
          input.autoDeploy ? 1 : 0,
          selectedStrategy,
          appId
        );
      } else {
        db.prepare(
          `
            UPDATE app_sources
            SET
              provider = ?,
              repository_owner = ?,
              repository_name = ?,
              repository_full_name = ?,
              repository_id = ?,
              repository_visibility = ?,
              repository_clone_url = ?,
              branch = ?,
              subdirectory = ?,
              deployment_mode = ?,
              dockerfile_path = ?,
              build_context = ?,
              container_port = ?,
              container_port_source = ?,
              container_port_confidence = ?,
              auto_deploy = ?,
              selected_strategy = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE app_id = ?
          `
        ).run(
          input.provider,
          input.repositoryOwner,
          input.repositoryName,
          input.repositoryFullName,
          input.repositoryId,
          input.repositoryVisibility,
          input.repositoryCloneUrl,
          input.branch,
          input.subdirectory,
          input.deploymentMode,
          input.dockerfilePath,
          input.buildContext,
          input.containerPort,
          containerPortSource,
          containerPortConfidence,
          input.autoDeploy ? 1 : 0,
          selectedStrategy,
          appId
        );
      }
    } else {
      db.prepare(
        `
          INSERT INTO app_sources (
            app_id, provider, repository_owner, repository_name,
            repository_full_name, repository_id, repository_visibility,
            repository_clone_url, branch, subdirectory, deployment_mode,
            dockerfile_path, build_context, container_port,
            container_port_source, container_port_confidence, auto_deploy,
            selected_strategy
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        appId,
        input.provider,
        input.repositoryOwner,
        input.repositoryName,
        input.repositoryFullName,
        input.repositoryId,
        input.repositoryVisibility,
        input.repositoryCloneUrl,
        input.branch,
        input.subdirectory,
        input.deploymentMode,
        input.dockerfilePath,
        input.buildContext,
        input.containerPort,
        containerPortSource,
        containerPortConfidence,
        input.autoDeploy ? 1 : 0,
        selectedStrategy
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

  /** Persists a repository-inspection result (detected type/strategy/remote commit). */
  function updateInspectionResult(appId: number, input: UpdateInspectionResultInput): void {
    const existing = getAppSource(appId);

    if (!existing) {
      throw new Error("No source configuration is linked to this app");
    }

    db.prepare(
      `
        UPDATE app_sources
        SET
          build_strategy = ?,
          detected_project_type = ?,
          latest_remote_commit_sha = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE app_id = ?
      `
    ).run(input.buildStrategy, input.detectedProjectType, input.latestRemoteCommitSha, appId);
  }

  /** Records what was actually deployed, once a GitHub deployment succeeds. */
  function updateDeployedCommit(appId: number, input: UpdateDeployedCommitInput): void {
    const existing = getAppSource(appId);

    if (!existing) {
      throw new Error("No source configuration is linked to this app");
    }

    db.prepare(
      `
        UPDATE app_sources
        SET
          latest_deployed_commit_sha = ?,
          latest_deployed_commit_message = ?,
          latest_deployed_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE app_id = ?
      `
    ).run(input.commitSha, input.commitMessage, input.deployedAt, appId);
  }

  /**
   * Records the most recent GitHub-deployment runtime verification
   * results, regardless of whether the deployment ultimately succeeded —
   * called on every outcome (PASS, ROLLED_BACK, ROLLBACK_FAILED) so the
   * Source tab always reflects what the last attempt actually found,
   * not just the last successful one.
   */
  function updateDeploymentHealthResult(
    appId: number,
    input: { lastInternalHealthResult: string | null; lastPublicHealthResult: string | null; lastDeploymentStatus: string | null }
  ): void {
    const existing = getAppSource(appId);

    if (!existing) {
      return;
    }

    db.prepare(
      `
        UPDATE app_sources
        SET
          last_internal_health_result = ?,
          last_public_health_result = ?,
          last_deployment_status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE app_id = ?
      `
    ).run(input.lastInternalHealthResult, input.lastPublicHealthResult, input.lastDeploymentStatus, appId);
  }

  /** Stores the output of the most recent image build for this app's source. */
  function updateBuildLog(appId: number, input: UpdateBuildLogInput): void {
    db.prepare(
      `
        UPDATE app_sources
        SET
          last_build_log = ?,
          last_build_log_truncated = ?,
          last_build_status = ?,
          last_build_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE app_id = ?
      `
    ).run(input.log, input.truncated ? 1 : 0, input.status, input.at, appId);
  }

  /** The most recent build log for this app, or null if it has no linked source. */
  function getBuildLog(appId: number): StoredBuildLog | null {
    const row = db
      .prepare(
        `SELECT last_build_log, last_build_log_truncated, last_build_status, last_build_at
         FROM app_sources WHERE app_id = ?`
      )
      .get(appId) as unknown as
      | {
          last_build_log: string | null;
          last_build_log_truncated: number;
          last_build_status: string | null;
          last_build_at: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      log: row.last_build_log,
      truncated: row.last_build_log_truncated === 1,
      status: row.last_build_status,
      at: row.last_build_at
    };
  }

  /** Toggles the auto-deploy preference. Returns false if the app has no source. */
  function setAutoDeploy(appId: number, enabled: boolean): boolean {
    const info = db
      .prepare(`UPDATE app_sources SET auto_deploy = ?, updated_at = CURRENT_TIMESTAMP WHERE app_id = ?`)
      .run(enabled ? 1 : 0, appId);
    return Number(info.changes) > 0;
  }

  /** Every source with auto-deploy enabled — the polling scheduler's candidate set. */
  function listAutoDeploySources(): AutoDeployCandidate[] {
    const rows = db
      .prepare(
        `SELECT app_id, repository_owner, repository_name, branch, latest_deployed_commit_sha, deployment_mode
         FROM app_sources WHERE auto_deploy = 1`
      )
      .all() as unknown as Array<{
      app_id: number;
      repository_owner: string | null;
      repository_name: string | null;
      branch: string;
      latest_deployed_commit_sha: string | null;
      deployment_mode: string;
    }>;

    return rows.map((row) => ({
      appId: row.app_id,
      repositoryOwner: row.repository_owner,
      repositoryName: row.repository_name,
      branch: row.branch,
      latestDeployedCommitSha: row.latest_deployed_commit_sha,
      deploymentMode: row.deployment_mode as DeploymentMode
    }));
  }

  function deleteAppSource(appId: number): void {
    db.prepare(`DELETE FROM app_sources WHERE app_id = ?`).run(appId);
  }

  /**
   * How long a deployment lock may be held before it is treated as
   * abandoned. The lock is released in a `finally`, but a hard crash, a
   * container restart, or an OOM kill between acquire and release leaves
   * the row behind with no owner — and because acquiring is a plain
   * INSERT on a unique column, that app could then NEVER deploy again.
   *
   * (Observed in production: an app sat locked for 35 hours, silently
   * refusing every deployment with "already in progress".)
   *
   * Two hours is far longer than any real deployment — the build itself is
   * separately bounded by its own timeout — so reclaiming a lock this old
   * can only ever free a leaked one, never interrupt live work.
   */
  const DEPLOYMENT_LOCK_STALE_SECONDS = 2 * 60 * 60;

  /**
   * Durable, crash-safe "one active GitHub deployment per app" lock,
   * backed by a real table rather than in-memory state — a process
   * restart mid-deployment doesn't leave an in-memory Set lying to the
   * next request. Returns false without inserting anything if a
   * deployment is already in progress for this app.
   */
  function acquireDeploymentLock(appId: number): boolean {
    // Reclaim this app's lock first if it is older than any real
    // deployment could be. Scoped to the one app, so a genuinely running
    // deployment of a different app is never disturbed.
    db.prepare(
      `DELETE FROM github_deployment_locks
        WHERE app_id = ?
          AND started_at <= datetime('now', ?)`
    ).run(appId, `-${DEPLOYMENT_LOCK_STALE_SECONDS} seconds`);

    try {
      db.prepare(
        `INSERT INTO github_deployment_locks (app_id, started_at) VALUES (?, CURRENT_TIMESTAMP)`
      ).run(appId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Drops EVERY deployment lock. Called once at startup — the fact that
   * this process is only now booting is itself proof that no deployment any
   * lock refers to is still running, so every lock is orphaned regardless
   * of age.
   *
   * This must NOT use the age threshold that `acquireDeploymentLock` uses.
   * A deploy of the platform itself restarts the API container mid-build,
   * orphaning a lock that is only seconds or minutes old; an age-gated
   * sweep left that lock in place and the app stuck in "Building image"
   * forever, refusing every retry as "already in progress". (Observed
   * live: staxxio, orphaned by a platform redeploy, wedged ~20 minutes.)
   */
  function releaseStaleDeploymentLocks(): number {
    const result = db.prepare(`DELETE FROM github_deployment_locks`).run();
    return Number(result.changes ?? 0);
  }

  function releaseDeploymentLock(appId: number): void {
    db.prepare(`DELETE FROM github_deployment_locks WHERE app_id = ?`).run(appId);
  }

  function isDeploymentLocked(appId: number): boolean {
    const row = db.prepare(`SELECT app_id FROM github_deployment_locks WHERE app_id = ?`).get(appId);
    return row !== undefined;
  }

  return {
    getAppSource,
    upsertAppSource,
    updateAppSourceValidation,
    updateInspectionResult,
    updateDeployedCommit,
    updateDeploymentHealthResult,
    updateBuildLog,
    getBuildLog,
    setAutoDeploy,
    listAutoDeploySources,
    deleteAppSource,
    acquireDeploymentLock,
    releaseDeploymentLock,
    releaseStaleDeploymentLocks,
    isDeploymentLocked
  };
}

export interface UpdateBuildLogInput {
  log: string;
  truncated: boolean;
  /** "success" | "failed" | "reused" */
  status: string;
  at: string;
}

export interface StoredBuildLog {
  log: string | null;
  truncated: boolean;
  status: string | null;
  at: string | null;
}

export interface AutoDeployCandidate {
  appId: number;
  repositoryOwner: string | null;
  repositoryName: string | null;
  branch: string;
  latestDeployedCommitSha: string | null;
  deploymentMode: DeploymentMode;
}

export type AppSourceRepository = ReturnType<typeof createAppSourceRepository>;
