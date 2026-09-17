import type { DatabaseSync } from "node:sqlite";

/**
 * Read/append access to platform_update_history — the durable record of the
 * platform's own self-update attempts (see migration 028). Append-only from
 * the API's perspective: the host updater inserts a row when an attempt
 * starts and updates that row when it finishes. Nothing here ever stores a
 * secret; callers pass only versions, channels, states, timestamps, and a
 * pre-redacted diagnostic string.
 */

export type UpdateResult =
  | "in_progress"
  | "successful"
  | "rolled_back"
  | "failed"
  | "manual_intervention_required";

export type UpdateTrigger = "automatic" | "manual" | "bootstrap";

export interface UpdateHistoryEntry {
  id: number;
  fromVersion: string | null;
  toVersion: string;
  channel: string;
  policy: string;
  trigger: UpdateTrigger;
  startedAt: string;
  finishedAt: string | null;
  result: UpdateResult;
  failureStage: string | null;
  healthResult: string | null;
  rollbackAttempted: boolean;
  rollbackResult: string | null;
  diagnostic: string | null;
  createdAt: string;
}

export interface StartUpdateAttemptInput {
  fromVersion: string | null;
  toVersion: string;
  channel: string;
  policy: string;
  trigger: UpdateTrigger;
  startedAt: string;
}

export interface FinishUpdateAttemptInput {
  id: number;
  finishedAt: string;
  result: UpdateResult;
  failureStage?: string | null;
  healthResult?: string | null;
  rollbackAttempted?: boolean;
  rollbackResult?: string | null;
  diagnostic?: string | null;
}

interface UpdateHistoryRow {
  id: number;
  from_version: string | null;
  to_version: string;
  channel: string;
  policy: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  result: string;
  failure_stage: string | null;
  health_result: string | null;
  rollback_attempted: number;
  rollback_result: string | null;
  diagnostic: string | null;
  created_at: string;
}

function toEntry(row: UpdateHistoryRow): UpdateHistoryEntry {
  return {
    id: row.id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    channel: row.channel,
    policy: row.policy,
    trigger: row.trigger as UpdateTrigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: row.result as UpdateResult,
    failureStage: row.failure_stage,
    healthResult: row.health_result,
    rollbackAttempted: row.rollback_attempted === 1,
    rollbackResult: row.rollback_result,
    diagnostic: row.diagnostic,
    createdAt: row.created_at
  };
}

export function createUpdateHistoryRepository(db: DatabaseSync) {
  function startUpdateAttempt(input: StartUpdateAttemptInput): number {
    const result = db
      .prepare(
        `INSERT INTO platform_update_history
           (from_version, to_version, channel, policy, trigger, started_at, result)
         VALUES (?, ?, ?, ?, ?, ?, 'in_progress')`
      )
      .run(
        input.fromVersion,
        input.toVersion,
        input.channel,
        input.policy,
        input.trigger,
        input.startedAt
      );
    return Number(result.lastInsertRowid);
  }

  function finishUpdateAttempt(input: FinishUpdateAttemptInput): void {
    db.prepare(
      `UPDATE platform_update_history
         SET finished_at = ?, result = ?, failure_stage = ?, health_result = ?,
             rollback_attempted = ?, rollback_result = ?, diagnostic = ?
       WHERE id = ?`
    ).run(
      input.finishedAt,
      input.result,
      input.failureStage ?? null,
      input.healthResult ?? null,
      input.rollbackAttempted ? 1 : 0,
      input.rollbackResult ?? null,
      input.diagnostic ?? null,
      input.id
    );
  }

  function listUpdateHistory(limit = 50): UpdateHistoryEntry[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = db
      .prepare(`SELECT * FROM platform_update_history ORDER BY id DESC LIMIT ?`)
      .all(bounded) as unknown as UpdateHistoryRow[];
    return rows.map(toEntry);
  }

  function getLatestSuccessfulUpdate(): UpdateHistoryEntry | null {
    const row = db
      .prepare(
        `SELECT * FROM platform_update_history WHERE result = 'successful' ORDER BY id DESC LIMIT 1`
      )
      .get() as unknown as UpdateHistoryRow | undefined;
    return row ? toEntry(row) : null;
  }

  /** Deletes all but the newest `keep` history rows, so the log can't grow without bound. */
  function pruneUpdateHistory(keep: number): number {
    const bounded = Math.max(1, Math.floor(keep));
    const result = db
      .prepare(
        `DELETE FROM platform_update_history
         WHERE id NOT IN (
           SELECT id FROM platform_update_history ORDER BY id DESC LIMIT ?
         )`
      )
      .run(bounded);
    return Number(result.changes ?? 0);
  }

  return {
    startUpdateAttempt,
    finishUpdateAttempt,
    listUpdateHistory,
    getLatestSuccessfulUpdate,
    pruneUpdateHistory
  };
}

export type UpdateHistoryRepository = ReturnType<typeof createUpdateHistoryRepository>;
