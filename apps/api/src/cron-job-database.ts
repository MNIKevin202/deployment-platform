import type { DatabaseSync } from "node:sqlite";

export interface StoredCronJob {
  id: number;
  appId: number;
  /** The app's name, joined in for display so the UI needn't re-fetch. */
  appName: string;
  /** The app's container name, for the executor. Null if never deployed. */
  containerName: string | null;
  name: string;
  cronExpression: string;
  command: string;
  enabled: boolean;
  timeoutSeconds: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastExitCode: number | null;
  lastOutput: string | null;
  lastDurationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCronJobInput {
  appId: number;
  name: string;
  cronExpression: string;
  command: string;
  enabled: boolean;
  timeoutSeconds: number;
}

export interface UpdateCronJobInput {
  name: string;
  cronExpression: string;
  command: string;
  enabled: boolean;
  timeoutSeconds: number;
}

export interface CronJobRunResult {
  status: "success" | "failed" | "timeout" | "skipped";
  exitCode: number | null;
  output: string;
  durationMs: number;
  ranAt: string;
}

interface CronJobRow {
  id: number;
  app_id: number;
  app_name: string;
  container_name: string | null;
  name: string;
  cron_expression: string;
  command: string;
  enabled: number;
  timeout_seconds: number;
  last_run_at: string | null;
  last_status: string | null;
  last_exit_code: number | null;
  last_output: string | null;
  last_duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: CronJobRow): StoredCronJob {
  return {
    id: row.id,
    appId: row.app_id,
    appName: row.app_name,
    containerName: row.container_name,
    name: row.name,
    cronExpression: row.cron_expression,
    command: row.command,
    enabled: row.enabled === 1,
    timeoutSeconds: row.timeout_seconds,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastExitCode: row.last_exit_code,
    lastOutput: row.last_output,
    lastDurationMs: row.last_duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * The cron_jobs repository. Every read joins the owning app so callers get
 * the app name and container name without a second query — the job is
 * meaningless without the app it targets.
 */
export function createCronJobRepository(db: DatabaseSync) {
  const SELECT = `
    SELECT
      c.*,
      a.name AS app_name,
      a.container_name AS container_name
    FROM cron_jobs c
    JOIN apps a ON a.id = c.app_id
  `;

  function listCronJobs(): StoredCronJob[] {
    return db
      .prepare(`${SELECT} ORDER BY c.id ASC`)
      .all()
      .map((row) => mapRow(row as unknown as CronJobRow));
  }

  function getCronJob(id: number): StoredCronJob | null {
    const row = db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as CronJobRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Only enabled jobs, for the scheduler's per-minute sweep. */
  function listEnabledCronJobs(): StoredCronJob[] {
    return db
      .prepare(`${SELECT} WHERE c.enabled = 1 ORDER BY c.id ASC`)
      .all()
      .map((row) => mapRow(row as unknown as CronJobRow));
  }

  function createCronJob(input: CreateCronJobInput): StoredCronJob {
    const result = db
      .prepare(
        `INSERT INTO cron_jobs (app_id, name, cron_expression, command, enabled, timeout_seconds)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.appId,
        input.name,
        input.cronExpression,
        input.command,
        input.enabled ? 1 : 0,
        input.timeoutSeconds
      );

    const created = getCronJob(Number(result.lastInsertRowid));
    if (!created) {
      throw new Error("Cron job was inserted but could not be read back");
    }
    return created;
  }

  function updateCronJob(id: number, input: UpdateCronJobInput): StoredCronJob | null {
    db.prepare(
      `UPDATE cron_jobs
         SET name = ?, cron_expression = ?, command = ?, enabled = ?, timeout_seconds = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      input.name,
      input.cronExpression,
      input.command,
      input.enabled ? 1 : 0,
      input.timeoutSeconds,
      id
    );

    return getCronJob(id);
  }

  function deleteCronJob(id: number): boolean {
    const result = db.prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(id);
    return Number(result.changes ?? 0) > 0;
  }

  /** Records the outcome of a run (scheduled or manual). */
  function recordCronJobRun(id: number, run: CronJobRunResult): void {
    db.prepare(
      `UPDATE cron_jobs
         SET last_run_at = ?, last_status = ?, last_exit_code = ?, last_output = ?,
             last_duration_ms = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(run.ranAt, run.status, run.exitCode, run.output, run.durationMs, id);
  }

  return {
    listCronJobs,
    getCronJob,
    listEnabledCronJobs,
    createCronJob,
    updateCronJob,
    deleteCronJob,
    recordCronJobRun
  };
}

export type CronJobRepository = ReturnType<typeof createCronJobRepository>;
