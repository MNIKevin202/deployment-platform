import type { DatabaseSync } from "node:sqlite";

/**
 * Retention policy (see migrations/012_idempotency_keys.ts for the full
 * rationale): a completed record is replayable for 24 hours, then eligible
 * for pruning. A record still "in_progress" after 5 minutes is treated as
 * abandoned (its owning request crashed or never completed) and its key
 * becomes available for a fresh attempt.
 */
const COMPLETED_RETENTION_HOURS = 24;
const IN_PROGRESS_ABANDONED_MINUTES = 5;

export type IdempotencyOutcome =
  | { kind: "reserved" }
  | { kind: "replay"; statusCode: number; body: unknown }
  | { kind: "in_progress" }
  | { kind: "mismatch" };

interface IdempotencyRow {
  id: number;
  key: string;
  scope: string;
  request_hash: string;
  status: "in_progress" | "completed";
  status_code: number | null;
  response_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export function createIdempotencyRepository(db: DatabaseSync) {
  function pruneStale(): void {
    db.prepare(
      `
        DELETE FROM idempotency_keys
        WHERE
          (status = 'completed' AND created_at < datetime('now', ?))
          OR
          (status = 'in_progress' AND created_at < datetime('now', ?))
      `
    ).run(`-${COMPLETED_RETENTION_HOURS} hours`, `-${IN_PROGRESS_ABANDONED_MINUTES} minutes`);
  }

  /**
   * Attempts to claim `key` within `scope` for a new operation.
   *
   *  - No existing (unexpired) record: the key is reserved as "in_progress"
   *    and the caller should proceed, then call `complete()`.
   *  - A completed record with a matching request hash: the original
   *    response is returned for the caller to replay verbatim — this is the
   *    core of "a retried request returns the original result."
   *  - A completed (or in-progress) record with a DIFFERENT request hash:
   *    "mismatch" — this key is already bound to a different logical
   *    request and must not be treated as idempotent with this one.
   *  - An in-progress, unexpired record with a matching hash: another
   *    request with this exact key is currently being processed.
   */
  function beginAttempt(
    key: string,
    scope: string,
    requestHash: string
  ): IdempotencyOutcome {
    pruneStale();

    try {
      db.prepare(
        `
          INSERT INTO idempotency_keys (key, scope, request_hash, status)
          VALUES (?, ?, ?, 'in_progress')
        `
      ).run(key, scope, requestHash);

      return { kind: "reserved" };
    } catch {
      // UNIQUE(scope, key) violation: a record already exists (and survived
      // pruneStale(), so it is not expired).
    }

    const existing = db
      .prepare(
        `SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?`
      )
      .get(scope, key) as unknown as IdempotencyRow | undefined;

    if (!existing) {
      // Pruned between the failed insert and this read — safe to retry the
      // reservation once; treat as a fresh attempt rather than looping.
      db.prepare(
        `
          INSERT INTO idempotency_keys (key, scope, request_hash, status)
          VALUES (?, ?, ?, 'in_progress')
        `
      ).run(key, scope, requestHash);

      return { kind: "reserved" };
    }

    if (existing.request_hash !== requestHash) {
      return { kind: "mismatch" };
    }

    if (existing.status === "completed") {
      return {
        kind: "replay",
        statusCode: existing.status_code ?? 200,
        body: existing.response_json ? JSON.parse(existing.response_json) : null
      };
    }

    return { kind: "in_progress" };
  }

  /** Records the outcome of a reserved attempt so future replays return it. */
  function complete(
    key: string,
    scope: string,
    statusCode: number,
    body: unknown
  ): void {
    db.prepare(
      `
        UPDATE idempotency_keys
        SET status = 'completed',
            status_code = ?,
            response_json = ?,
            completed_at = CURRENT_TIMESTAMP
        WHERE scope = ? AND key = ?
      `
    ).run(statusCode, JSON.stringify(body), scope, key);
  }

  /**
   * Releases a reservation after the underlying operation failed, so the
   * SAME key can be used to genuinely retry from scratch — a failure must
   * never be cached and replayed as if it were the original outcome.
   */
  function releaseFailedAttempt(key: string, scope: string): void {
    db.prepare(
      `DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND status = 'in_progress'`
    ).run(scope, key);
  }

  return {
    beginAttempt,
    complete,
    releaseFailedAttempt
  };
}

export type IdempotencyRepository = ReturnType<typeof createIdempotencyRepository>;
