import type { DatabaseSync } from "node:sqlite";

/**
 * How a deployed version came to be:
 *  - "github": built from a repository commit into a retained
 *    `deployment-app-<id>:<shortSha>` image, so it can be reverted to.
 *  - "image": a plain Docker image the app runs directly (databases,
 *    manually-specified images). Current-only — no per-version revert.
 */
export type DeploymentSourceKind = "github" | "image";

export interface StoredDeployment {
  id: number;
  appId: number;
  /** Monotonic per app, starting at 1. Never reused. */
  version: number;
  imageTag: string;
  commitSha: string | null;
  commitMessage: string | null;
  sourceKind: DeploymentSourceKind;
  /** Set when this version was produced by reverting to an earlier one. */
  revertOfVersion: number | null;
  isCurrent: boolean;
  createdAt: string;
}

interface DeploymentRow {
  id: number;
  app_id: number;
  version: number;
  image_tag: string;
  commit_sha: string | null;
  commit_message: string | null;
  source_kind: string;
  revert_of_version: number | null;
  is_current: number;
  created_at: string;
}

const DEPLOYMENT_COLUMNS = `
  id, app_id, version, image_tag, commit_sha, commit_message,
  source_kind, revert_of_version, is_current, created_at
`;

function mapDeployment(row: DeploymentRow): StoredDeployment {
  return {
    id: row.id,
    appId: row.app_id,
    version: row.version,
    imageTag: row.image_tag,
    commitSha: row.commit_sha,
    commitMessage: row.commit_message,
    sourceKind: row.source_kind === "github" ? "github" : "image",
    revertOfVersion: row.revert_of_version,
    isCurrent: row.is_current === 1,
    createdAt: row.created_at
  };
}

export interface RecordDeploymentInput {
  appId: number;
  imageTag: string;
  commitSha: string | null;
  commitMessage: string | null;
  sourceKind: DeploymentSourceKind;
  /** Present only when this deployment is a revert to `revertOfVersion`. */
  revertOfVersion?: number | null;
}

export function createDeploymentRepository(db: DatabaseSync) {
  /**
   * Appends a new version and makes it the current one. Version numbers are
   * allocated per app (max + 1), so a revert appends a *new* higher version
   * pointing at an older image rather than mutating history. The clear +
   * insert run in a single transaction so exactly one row per app is ever
   * marked current.
   */
  function recordDeployment(input: RecordDeploymentInput): StoredDeployment {
    db.exec("BEGIN");

    let version: number;

    try {
      const maxRow = db
        .prepare("SELECT MAX(version) AS max_version FROM app_deployments WHERE app_id = ?")
        .get(input.appId) as unknown as { max_version: number | null };

      version = (maxRow?.max_version ?? 0) + 1;

      db.prepare("UPDATE app_deployments SET is_current = 0 WHERE app_id = ? AND is_current = 1").run(
        input.appId
      );

      db.prepare(
        `
          INSERT INTO app_deployments (
            app_id, version, image_tag, commit_sha, commit_message,
            source_kind, revert_of_version, is_current
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `
      ).run(
        input.appId,
        version,
        input.imageTag,
        input.commitSha,
        input.commitMessage,
        input.sourceKind,
        input.revertOfVersion ?? null
      );

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const row = db
      .prepare(`SELECT ${DEPLOYMENT_COLUMNS} FROM app_deployments WHERE app_id = ? AND version = ?`)
      .get(input.appId, version) as unknown as DeploymentRow;

    return mapDeployment(row);
  }

  function listDeployments(appId: number, limit: number): StoredDeployment[] {
    const rows = db
      .prepare(
        `SELECT ${DEPLOYMENT_COLUMNS} FROM app_deployments WHERE app_id = ? ORDER BY version DESC LIMIT ?`
      )
      .all(appId, limit) as unknown as DeploymentRow[];

    return rows.map(mapDeployment);
  }

  function getDeployment(appId: number, version: number): StoredDeployment | null {
    const row = db
      .prepare(`SELECT ${DEPLOYMENT_COLUMNS} FROM app_deployments WHERE app_id = ? AND version = ?`)
      .get(appId, version) as unknown as DeploymentRow | undefined;

    return row ? mapDeployment(row) : null;
  }

  function getCurrentDeployment(appId: number): StoredDeployment | null {
    const row = db
      .prepare(
        `SELECT ${DEPLOYMENT_COLUMNS} FROM app_deployments WHERE app_id = ? AND is_current = 1 LIMIT 1`
      )
      .get(appId) as unknown as DeploymentRow | undefined;

    return row ? mapDeployment(row) : null;
  }

  return {
    recordDeployment,
    listDeployments,
    getDeployment,
    getCurrentDeployment
  };
}

export type DeploymentRepository = ReturnType<typeof createDeploymentRepository>;
