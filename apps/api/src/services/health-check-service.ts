import http from "node:http";
import type { AppDatabase, HealthState, StoredAppHealthCheck } from "../database.js";
import type { RecordEventFn } from "./deployment-event-service.js";

const MAX_ERROR_MESSAGE_LENGTH = 300;

export function sanitizeHealthCheckError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  }

  return "Unknown error";
}

export interface HealthCheckHttpRequestOptions {
  hostname: string;
  port: number;
  path: string;
  timeoutMs: number;
}

export interface HealthCheckHttpResponse {
  statusCode: number;
  latencyMs: number;
}

/**
 * The narrow network operation a health check actually needs. Kept
 * separate from Node's `http` module so the check logic can be tested with
 * a fake client — no real sockets, no real timers.
 */
export interface HealthCheckHttpClient {
  request(options: HealthCheckHttpRequestOptions): Promise<HealthCheckHttpResponse>;
}

/**
 * Real implementation: a single unstreamed GET against the app's own
 * container name and internal port over the Docker network. Response
 * bodies are always drained and discarded — never buffered, inspected, or
 * stored.
 */
export function createHttpHealthCheckClient(): HealthCheckHttpClient {
  return {
    request({ hostname, port, path, timeoutMs }) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const start = Date.now();

        const req = http.request(
          {
            hostname,
            port,
            path,
            method: "GET",
            timeout: timeoutMs
          },
          (res) => {
            const latencyMs = Date.now() - start;
            const statusCode = res.statusCode ?? 0;

            // Drain and discard the body — this service never stores or
            // inspects response content, only the status code and timing.
            res.resume();
            res.on("error", () => {});

            if (!settled) {
              settled = true;
              resolve({ statusCode, latencyMs });
            }
          }
        );

        req.on("timeout", () => {
          if (!settled) {
            settled = true;
            req.destroy();
            reject(new Error(`Health check timed out after ${timeoutMs}ms`));
          }
        });

        req.on("error", (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });

        req.end();
      });
    }
  };
}

export interface ComputeNextHealthStateInput {
  previousState: HealthState;
  success: boolean;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  successThreshold: number;
  failureThreshold: number;
}

/**
 * Pure threshold logic, isolated so it can be tested exhaustively without
 * any I/O. A single success or failure never immediately flips a settled
 * state — enough consecutive results in the new direction are required
 * first, which is what keeps a flapping app from bouncing the badge on
 * every tick.
 */
export function computeNextHealthState(input: ComputeNextHealthStateInput): HealthState {
  const {
    previousState,
    success,
    consecutiveSuccesses,
    consecutiveFailures,
    successThreshold,
    failureThreshold
  } = input;

  if (success) {
    if (consecutiveSuccesses >= successThreshold) {
      return "healthy";
    }

    return previousState === "unhealthy" ? "unhealthy" : "unknown";
  }

  if (consecutiveFailures >= failureThreshold) {
    return "unhealthy";
  }

  return previousState === "healthy" ? "healthy" : "unknown";
}

export interface HealthCheckLogger {
  info: (obj: unknown, message?: string) => void;
  warn: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface HealthCheckDependencies {
  appDatabase: Pick<AppDatabase, "getAppById" | "getAppHealthCheck" | "updateHealthState">;
  httpClient: HealthCheckHttpClient;
  /** Resolved by container name only — never by a client-supplied id. */
  isContainerRunning: (containerName: string) => Promise<boolean>;
  recordEvent: RecordEventFn;
  logger: HealthCheckLogger;
  now?: () => Date;
}

export type HealthCheckSkipReason = "app-not-found" | "not-configured";

export interface HealthCheckOutcome {
  appId: number;
  skipped: boolean;
  reason?: HealthCheckSkipReason;
  state?: HealthState;
  changed: boolean;
  /**
   * False when the check ran (a real container/HTTP probe was performed)
   * but nothing was written to the database — this happens for a manual
   * check against a disabled configuration, where `state`/`statusCode`/
   * `latencyMs`/`errorMessage` describe what the probe found, purely for
   * display, without moving persistent config away from "disabled".
   */
  persisted: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  errorMessage?: string | null;
}

/**
 * The one authoritative implementation of "run a health check for this
 * app" — the scheduler's periodic tick and the manual "Run Check Now"
 * endpoint both call this directly, so there is no second copy of the
 * threshold/state logic to drift out of sync.
 *
 * Every attempted check — scheduled or manual, changed or unchanged,
 * container running or not — advances `lastCheckedAt` when the check is
 * persisted, so the scheduler's due-time calculation always reflects the
 * last real attempt. Only *events* are gated on an actual state change;
 * the timestamp write is not.
 */
export async function performHealthCheck(
  deps: HealthCheckDependencies,
  appId: number
): Promise<HealthCheckOutcome> {
  const { appDatabase, httpClient, isContainerRunning, recordEvent, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const app = appDatabase.getAppById(appId);

  if (!app) {
    return { appId, skipped: true, reason: "app-not-found", changed: false, persisted: false };
  }

  const config = appDatabase.getAppHealthCheck(appId);

  if (!config) {
    return { appId, skipped: true, reason: "not-configured", changed: false, persisted: false };
  }

  const previousState = config.state;
  const nowIso = now().toISOString();

  // A manual check against a disabled configuration still performs a real
  // probe (useful for testing a path before turning monitoring on), but
  // must never move the persisted state away from "disabled" or otherwise
  // write to the row — see routes/health.ts and the Phase 9 hardening
  // notes for the chosen rule.
  const persist = config.enabled;

  try {
    const containerName = app.containerName;
    const running = containerName ? await isContainerRunning(containerName) : false;

    if (!running) {
      const changed = previousState !== "container-not-running";

      if (persist) {
        appDatabase.updateHealthState(appId, {
          state: "container-not-running",
          lastCheckedAt: nowIso,
          consecutiveSuccesses: 0,
          consecutiveFailures: 0,
          lastError: null
        });

        if (changed && previousState === "healthy") {
          recordEvent({
            appId,
            eventType: "health-became-unhealthy",
            severity: "warning",
            message: `${app.name} is no longer healthy — its container is not running`,
            metadata: { previousState }
          });
        }
      }

      return {
        appId,
        skipped: false,
        state: "container-not-running",
        changed: persist && changed,
        persisted: persist
      };
    }

    const outcome = await runSingleCheck(httpClient, containerName as string, app.containerPort, config);

    if (!persist) {
      // No multi-check history to aggregate against for an unmonitored
      // probe — report this single observation directly rather than
      // running it through threshold math that assumes a tracked series.
      return {
        appId,
        skipped: false,
        state: outcome.success ? "healthy" : "unhealthy",
        changed: false,
        persisted: false,
        statusCode: outcome.statusCode,
        latencyMs: outcome.latencyMs,
        errorMessage: outcome.errorMessage
      };
    }

    const consecutiveSuccesses = outcome.success ? config.consecutiveSuccesses + 1 : 0;
    const consecutiveFailures = outcome.success ? 0 : config.consecutiveFailures + 1;

    const nextState = computeNextHealthState({
      previousState,
      success: outcome.success,
      consecutiveSuccesses,
      consecutiveFailures,
      successThreshold: config.successThreshold,
      failureThreshold: config.failureThreshold
    });

    appDatabase.updateHealthState(appId, {
      state: nextState,
      lastCheckedAt: nowIso,
      lastSuccessAt: outcome.success ? nowIso : config.lastSuccessAt,
      lastFailureAt: !outcome.success ? nowIso : config.lastFailureAt,
      lastStatusCode: outcome.statusCode,
      lastLatencyMs: outcome.latencyMs,
      consecutiveSuccesses,
      consecutiveFailures,
      lastError: outcome.errorMessage
    });

    if (nextState !== previousState) {
      if (nextState === "healthy") {
        recordEvent({
          appId,
          eventType: "health-became-healthy",
          severity: "info",
          message: `${app.name} is now healthy`,
          metadata: { previousState, statusCode: outcome.statusCode, latencyMs: outcome.latencyMs }
        });
      } else if (nextState === "unhealthy") {
        recordEvent({
          appId,
          eventType: "health-became-unhealthy",
          severity: "warning",
          message: `${app.name} is now unhealthy${outcome.errorMessage ? `: ${outcome.errorMessage}` : ""}`,
          metadata: { previousState, statusCode: outcome.statusCode }
        });
      }
    }

    return {
      appId,
      skipped: false,
      state: nextState,
      changed: nextState !== previousState,
      persisted: true,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      errorMessage: outcome.errorMessage
    };
  } catch (error) {
    const sanitized = sanitizeHealthCheckError(error);

    logger.error({ appId, error: sanitized }, "Health check failed unexpectedly");

    if (persist) {
      try {
        appDatabase.updateHealthState(appId, {
          state: "error",
          lastCheckedAt: nowIso,
          lastError: sanitized
        });
      } catch (writeError) {
        logger.error(
          { appId, error: sanitizeHealthCheckError(writeError) },
          "Failed to persist health check error state"
        );
      }

      recordEvent({
        appId,
        eventType: "health-check-error",
        severity: "error",
        message: `Health check for "${app.name}" failed unexpectedly`,
        metadata: { error: sanitized }
      });
    }

    return {
      appId,
      skipped: false,
      state: "error",
      changed: persist && previousState !== "error",
      persisted: persist,
      errorMessage: sanitized
    };
  }
}

interface SingleCheckOutcome {
  success: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
}

async function runSingleCheck(
  httpClient: HealthCheckHttpClient,
  containerName: string,
  containerPort: number,
  config: StoredAppHealthCheck
): Promise<SingleCheckOutcome> {
  try {
    const result = await httpClient.request({
      hostname: containerName,
      port: containerPort,
      path: config.path,
      timeoutMs: config.timeoutSeconds * 1000
    });

    const success = result.statusCode === config.expectedStatus;

    return {
      success,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      errorMessage: success
        ? null
        : `Unexpected status code ${result.statusCode} (expected ${config.expectedStatus})`
    };
  } catch (error) {
    return {
      success: false,
      statusCode: null,
      latencyMs: null,
      errorMessage: sanitizeHealthCheckError(error)
    };
  }
}

export interface SchedulerTimerHandle {
  unref?: () => void;
}

export interface HealthCheckSchedulerOptions {
  appDatabase: Pick<
    AppDatabase,
    "listEnabledHealthChecks" | "getAppById" | "getAppHealthCheck" | "updateHealthState"
  >;
  httpClient: HealthCheckHttpClient;
  isContainerRunning: (containerName: string) => Promise<boolean>;
  recordEvent: RecordEventFn;
  logger: HealthCheckLogger;
  now?: () => Date;
  /** How often the scheduler wakes up to see which apps are due. Default 5s. */
  tickIntervalMs?: number;
  /** Injectable timer functions so tests never depend on real timers. */
  setIntervalFn?: (handler: () => void, ms: number) => SchedulerTimerHandle;
  clearIntervalFn?: (handle: SchedulerTimerHandle) => void;
}

export interface HealthCheckScheduler {
  start(): void;
  stop(): void;
  /** Runs one scheduler pass immediately — used internally by the timer and directly by tests. */
  runTickOnce(): Promise<void>;
  /** Runs a single app's check immediately, bypassing the due-time check, for the manual "Run Check Now" action. */
  runCheckNow(appId: number): Promise<HealthCheckOutcome>;
}

/**
 * One centralized interval drives every app's health check rather than a
 * timer per app. Overlapping checks for the same app are prevented with an
 * in-flight set; the timer is unref'd so its mere existence never keeps the
 * Node process alive, and `stop()` clears it outright for an orderly
 * shutdown.
 */
export function createHealthCheckScheduler(
  options: HealthCheckSchedulerOptions
): HealthCheckScheduler {
  const tickIntervalMs = options.tickIntervalMs ?? 5000;
  const now = options.now ?? (() => new Date());
  const setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle) => clearInterval(handle as unknown as NodeJS.Timeout));

  const inFlight = new Set<number>();
  let timerHandle: SchedulerTimerHandle | null = null;

  const deps: HealthCheckDependencies = {
    appDatabase: options.appDatabase,
    httpClient: options.httpClient,
    isContainerRunning: options.isContainerRunning,
    recordEvent: options.recordEvent,
    logger: options.logger,
    now
  };

  function isDue(config: StoredAppHealthCheck): boolean {
    if (!config.lastCheckedAt) {
      return true;
    }

    const lastCheckedMs = new Date(config.lastCheckedAt).getTime();

    if (Number.isNaN(lastCheckedMs)) {
      return true;
    }

    return now().getTime() - lastCheckedMs >= config.intervalSeconds * 1000;
  }

  async function runTickOnce(): Promise<void> {
    let configs: StoredAppHealthCheck[];

    try {
      configs = options.appDatabase.listEnabledHealthChecks();
    } catch (error) {
      options.logger.error(
        { error: sanitizeHealthCheckError(error) },
        "Health check scheduler failed to list enabled checks"
      );
      return;
    }

    for (const config of configs) {
      if (inFlight.has(config.appId) || !isDue(config)) {
        continue;
      }

      inFlight.add(config.appId);

      void performHealthCheck(deps, config.appId)
        .catch((error) => {
          options.logger.error(
            { appId: config.appId, error: sanitizeHealthCheckError(error) },
            "Unhandled health check error"
          );
        })
        .finally(() => {
          inFlight.delete(config.appId);
        });
    }
  }

  return {
    start() {
      if (timerHandle) {
        return;
      }

      timerHandle = setIntervalFn(() => {
        void runTickOnce();
      }, tickIntervalMs);

      timerHandle.unref?.();
    },

    stop() {
      if (timerHandle) {
        clearIntervalFn(timerHandle);
        timerHandle = null;
      }
    },

    runTickOnce,

    async runCheckNow(appId: number) {
      if (inFlight.has(appId)) {
        throw new Error("A health check for this app is already in progress");
      }

      inFlight.add(appId);

      try {
        return await performHealthCheck(deps, appId);
      } finally {
        inFlight.delete(appId);
      }
    }
  };
}
