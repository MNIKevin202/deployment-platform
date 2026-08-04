import type { RetentionCleanupResult } from "./deployment-retention-service.js";

/**
 * A tiny time-based scheduler that runs the deployment-retention safety-net
 * sweep once daily, so disk stays bounded even if a deployment fails midway
 * and never triggers its own post-deploy cleanup. Mirrors backup-scheduler.ts:
 * a cheap tick checks whether the sweep is due (via a persisted last-run
 * timestamp) and runs it if so. All timers are injectable so the whole thing
 * is unit-testable without real time.
 */

export interface RetentionSchedulerLogger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface RetentionSchedulerOptions {
  getLastRunAt: () => number | null;
  setLastRunAt: (ms: number) => void;
  /** Runs the global sweep. Never throws (the runner collects failures). */
  runSweep: () => Promise<RetentionCleanupResult>;
  logger: RetentionSchedulerLogger;
  /** How often the sweep should run. Defaults to 24h. */
  intervalMs?: number;
  /** How often to check whether the sweep is due. Defaults to hourly. */
  tickIntervalMs?: number;
  now?: () => Date;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface RetentionScheduler {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1000;

export function createRetentionScheduler(options: RetentionSchedulerOptions): RetentionScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle) => clearInterval(handle as unknown as NodeJS.Timeout));

  let timerHandle: unknown = null;
  let inFlight = false;

  async function runOnce(): Promise<void> {
    if (inFlight) {
      return;
    }

    const lastRunAt = options.getLastRunAt();
    if (lastRunAt !== null && now().getTime() - lastRunAt < intervalMs) {
      return;
    }

    inFlight = true;
    try {
      const result = await options.runSweep();
      options.setLastRunAt(now().getTime());
      if (result.failures.length > 0) {
        options.logger.error(
          { failures: result.failures.length },
          "Scheduled retention sweep completed with failures"
        );
      }
    } catch (error) {
      // runGlobalSweep is best-effort and shouldn't throw, but guard anyway so
      // a scheduler tick can never crash the process.
      options.logger.error(
        { error: error instanceof Error ? error.message : "unknown" },
        "Scheduled retention sweep failed"
      );
    } finally {
      inFlight = false;
    }
  }

  return {
    runOnce,
    start() {
      if (timerHandle !== null) {
        return;
      }
      timerHandle = setIntervalFn(() => {
        void runOnce();
      }, tickIntervalMs);
    },
    stop() {
      if (timerHandle !== null) {
        clearIntervalFn(timerHandle);
        timerHandle = null;
      }
    }
  };
}
