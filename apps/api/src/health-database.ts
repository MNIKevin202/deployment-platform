import type { DatabaseSync } from "node:sqlite";

export type HealthState =
  | "disabled"
  | "unknown"
  | "healthy"
  | "unhealthy"
  | "checking"
  | "container-not-running"
  | "error";

export interface StoredAppHealthCheck {
  appId: number;
  enabled: boolean;
  path: string;
  expectedStatus: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
  state: HealthState;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AppHealthCheckRow {
  app_id: number;
  enabled: number;
  path: string;
  expected_status: number;
  interval_seconds: number;
  timeout_seconds: number;
  failure_threshold: number;
  success_threshold: number;
  state: string;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_status_code: number | null;
  last_latency_ms: number | null;
  consecutive_successes: number;
  consecutive_failures: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const HEALTH_CHECK_COLUMNS = `
  app_id, enabled, path, expected_status, interval_seconds, timeout_seconds,
  failure_threshold, success_threshold, state, last_checked_at,
  last_success_at, last_failure_at, last_status_code, last_latency_ms,
  consecutive_successes, consecutive_failures, last_error, created_at,
  updated_at
`;

function mapHealthCheck(row: AppHealthCheckRow): StoredAppHealthCheck {
  return {
    appId: row.app_id,
    enabled: row.enabled === 1,
    path: row.path,
    expectedStatus: row.expected_status,
    intervalSeconds: row.interval_seconds,
    timeoutSeconds: row.timeout_seconds,
    failureThreshold: row.failure_threshold,
    successThreshold: row.success_threshold,
    state: row.state as HealthState,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastStatusCode: row.last_status_code,
    lastLatencyMs: row.last_latency_ms,
    consecutiveSuccesses: row.consecutive_successes,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface UpsertHealthConfigInput {
  enabled: boolean;
  path: string;
  expectedStatus: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
}

export interface UpdateHealthStateInput {
  state: HealthState;
  lastCheckedAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastStatusCode?: number | null;
  lastLatencyMs?: number | null;
  consecutiveSuccesses?: number;
  consecutiveFailures?: number;
  lastError?: string | null;
}

export function createHealthRepository(db: DatabaseSync) {
  function getAppHealthCheck(appId: number): StoredAppHealthCheck | null {
    const row = db
      .prepare(`SELECT ${HEALTH_CHECK_COLUMNS} FROM app_health_checks WHERE app_id = ?`)
      .get(appId) as unknown as AppHealthCheckRow | undefined;

    return row ? mapHealthCheck(row) : null;
  }

  function listEnabledHealthChecks(): StoredAppHealthCheck[] {
    const rows = db
      .prepare(`SELECT ${HEALTH_CHECK_COLUMNS} FROM app_health_checks WHERE enabled = 1`)
      .all() as unknown as AppHealthCheckRow[];

    return rows.map(mapHealthCheck);
  }

  /**
   * Creates the config row on first write, or updates it in place. The
   * config row doubles as the state row (one row per app), so an edit to
   * settings alone (interval/timeout with everything else unchanged)
   * preserves the tracked state/counters. Three other transitions are
   * handled explicitly rather than left to "whatever the counters happen
   * to say":
   *
   * - Disabling (enabled true -> false): state becomes "disabled" and the
   *   consecutive counters reset to 0, so a disabled check can never keep
   *   displaying a stale "healthy"/"unhealthy" verdict it is no longer
   *   producing. `lastError` is cleared for the same reason — it described
   *   monitoring that has now stopped. `lastSuccessAt`/`lastFailureAt`/
   *   `lastStatusCode`/`lastLatencyMs`/`lastCheckedAt` are left alone as
   *   historical context for the operator. No event is recorded — turning
   *   monitoring off is not itself a health transition.
   * - Enabling (enabled false -> true): state becomes "unknown" and the
   *   counters reset to 0 — a stale healthy/unhealthy verdict from before
   *   the check was disabled must never be reused. `last_checked_at` is
   *   cleared to null so the scheduler's `isDue()` (which treats a null
   *   timestamp as immediately due) picks it up on the very next tick
   *   rather than waiting a full interval.
   * - Editing while it stays enabled: the current settled state is kept,
   *   but if `path`, `expectedStatus`, `failureThreshold`, or
   *   `successThreshold` changed, the in-progress consecutive counters are
   *   reset to 0 — they were counted against criteria that no longer
   *   apply, so keeping them would misrepresent how close the app is to
   *   its next transition under the new configuration.
   */
  function upsertHealthConfig(
    appId: number,
    input: UpsertHealthConfigInput
  ): StoredAppHealthCheck {
    const existing = getAppHealthCheck(appId);

    if (existing) {
      const wasEnabled = existing.enabled;
      const willBeEnabled = input.enabled;

      let nextState: HealthState = existing.state;
      let resetCounters = false;
      let clearLastError = false;
      let clearLastCheckedAt = false;

      if (wasEnabled && !willBeEnabled) {
        nextState = "disabled";
        resetCounters = true;
        clearLastError = true;
      } else if (!wasEnabled && willBeEnabled) {
        nextState = "unknown";
        resetCounters = true;
        clearLastCheckedAt = true;
      } else if (wasEnabled && willBeEnabled) {
        const criteriaChanged =
          existing.path !== input.path ||
          existing.expectedStatus !== input.expectedStatus ||
          existing.failureThreshold !== input.failureThreshold ||
          existing.successThreshold !== input.successThreshold;

        if (criteriaChanged) {
          resetCounters = true;
        }
      }
      // wasEnabled === false && willBeEnabled === false: already disabled
      // and inert — no state/counter change needed.

      db.prepare(
        `
          UPDATE app_health_checks
          SET
            enabled = ?,
            path = ?,
            expected_status = ?,
            interval_seconds = ?,
            timeout_seconds = ?,
            failure_threshold = ?,
            success_threshold = ?,
            state = ?,
            consecutive_successes = ?,
            consecutive_failures = ?,
            last_checked_at = ?,
            last_error = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE app_id = ?
        `
      ).run(
        input.enabled ? 1 : 0,
        input.path,
        input.expectedStatus,
        input.intervalSeconds,
        input.timeoutSeconds,
        input.failureThreshold,
        input.successThreshold,
        nextState,
        resetCounters ? 0 : existing.consecutiveSuccesses,
        resetCounters ? 0 : existing.consecutiveFailures,
        clearLastCheckedAt ? null : existing.lastCheckedAt,
        clearLastError ? null : existing.lastError,
        appId
      );
    } else {
      db.prepare(
        `
          INSERT INTO app_health_checks (
            app_id, enabled, path, expected_status, interval_seconds,
            timeout_seconds, failure_threshold, success_threshold, state
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        appId,
        input.enabled ? 1 : 0,
        input.path,
        input.expectedStatus,
        input.intervalSeconds,
        input.timeoutSeconds,
        input.failureThreshold,
        input.successThreshold,
        input.enabled ? "unknown" : "disabled"
      );
    }

    const result = getAppHealthCheck(appId);

    if (!result) {
      throw new Error("Health check configuration could not be loaded after saving");
    }

    return result;
  }

  function updateHealthState(appId: number, input: UpdateHealthStateInput): void {
    const existing = getAppHealthCheck(appId);

    if (!existing) {
      throw new Error("Health check is not configured for this app");
    }

    db.prepare(
      `
        UPDATE app_health_checks
        SET
          state = ?,
          last_checked_at = ?,
          last_success_at = ?,
          last_failure_at = ?,
          last_status_code = ?,
          last_latency_ms = ?,
          consecutive_successes = ?,
          consecutive_failures = ?,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE app_id = ?
      `
    ).run(
      input.state,
      input.lastCheckedAt !== undefined ? input.lastCheckedAt : existing.lastCheckedAt,
      input.lastSuccessAt !== undefined ? input.lastSuccessAt : existing.lastSuccessAt,
      input.lastFailureAt !== undefined ? input.lastFailureAt : existing.lastFailureAt,
      input.lastStatusCode !== undefined ? input.lastStatusCode : existing.lastStatusCode,
      input.lastLatencyMs !== undefined ? input.lastLatencyMs : existing.lastLatencyMs,
      input.consecutiveSuccesses !== undefined
        ? input.consecutiveSuccesses
        : existing.consecutiveSuccesses,
      input.consecutiveFailures !== undefined
        ? input.consecutiveFailures
        : existing.consecutiveFailures,
      input.lastError !== undefined ? input.lastError : existing.lastError,
      appId
    );
  }

  return {
    getAppHealthCheck,
    listEnabledHealthChecks,
    upsertHealthConfig,
    updateHealthState
  };
}

export type HealthRepository = ReturnType<typeof createHealthRepository>;
