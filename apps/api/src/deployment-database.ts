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
  durationMs: number | null;
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
  duration_ms: number | null;
  is_current: number;
  created_at: string;
}

const DEPLOYMENT_COLUMNS = `
  id, app_id, version, image_tag, commit_sha, commit_message,
  source_kind, revert_of_version, duration_ms, is_current, created_at
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
    durationMs: row.duration_ms,
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
  /** End-to-end deploy duration in milliseconds. Null for legacy or unknown rows. */
  durationMs?: number | null;
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
            source_kind, revert_of_version, duration_ms, is_current
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `
      ).run(
        input.appId,
        version,
        input.imageTag,
        input.commitSha,
        input.commitMessage,
        input.sourceKind,
        input.revertOfVersion ?? null,
        input.durationMs ?? null
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

  /**
   * Every GitHub-built version for one app, newest first and unbounded (unlike
   * listDeployments, which is capped for the History panel). Retention needs
   * the complete list to decide which versions fall beyond the keep count.
   * Only "github" versions are returned: they alone have a retained, per-commit
   * image that is a rollback target and therefore a cleanup candidate.
   */
  function listGithubDeployments(appId: number): StoredDeployment[] {
    const rows = db
      .prepare(
        `SELECT ${DEPLOYMENT_COLUMNS} FROM app_deployments
         WHERE app_id = ? AND source_kind = 'github'
         ORDER BY version DESC`
      )
      .all(appId) as unknown as DeploymentRow[];

    return rows.map(mapDeployment);
  }

  /**
   * Every GitHub-built version across all apps, newest first per app. Retention
   * uses this to build the set of image tags still referenced by a retained
   * version anywhere — so an image shared by another app's retained version is
   * never removed while cleaning up this app.
   */
  function listAllGithubDeployments(): StoredDeployment[] {
    const rows = db
      .prepare(
        `SELECT ${DEPLOYMENT_COLUMNS} FROM app_deployments
         WHERE source_kind = 'github'
         ORDER BY app_id ASC, version DESC`
      )
      .all() as unknown as DeploymentRow[];

    return rows.map(mapDeployment);
  }

  /**
   * Removes the given versions of one app from the ledger. The current version
   * is refused outright (defence in depth — retention never selects it, but a
   * bug must never be able to delete the live version's row): the DELETE
   * explicitly excludes is_current = 1. Runs in a single transaction and
   * returns how many rows were actually removed.
   */
  function deleteDeployments(appId: number, versions: number[]): number {
    if (versions.length === 0) {
      return 0;
    }

    const placeholders = versions.map(() => "?").join(", ");
    const statement = db.prepare(
      `DELETE FROM app_deployments
       WHERE app_id = ? AND is_current = 0 AND version IN (${placeholders})`
    );

    db.exec("BEGIN");
    try {
      const result = statement.run(appId, ...versions);
      db.exec("COMMIT");
      return Number(result.changes ?? 0);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    recordDeployment,
    listDeployments,
    getDeployment,
    getCurrentDeployment,
    listGithubDeployments,
    listAllGithubDeployments,
    deleteDeployments
  };
}

export type DeploymentRepository = ReturnType<typeof createDeploymentRepository>;
