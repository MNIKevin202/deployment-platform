import type { CronJobRepository, StoredCronJob } from "../cron-job-database.js";
import { cronMatches, parseCronExpression } from "./cron-expression.js";
import { runCronJob, type CronDockerOps } from "./cron-executor-service.js";

export interface CronSchedulerLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface CronSchedulerOptions {
  repository: Pick<CronJobRepository, "listEnabledCronJobs" | "recordCronJobRun">;
  dockerOps: CronDockerOps;
  logger: CronSchedulerLogger;
  /**
   * How often to check whether any job is due. Defaults to 30s so a job can
   * never be missed within its one-minute window, while the per-minute
   * guard below stops a job running twice in the same minute.
   */
  tickIntervalMs?: number;
  now?: () => Date;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface CronScheduler {
  start: () => void;
  stop: () => void;
  /** Runs a single evaluation pass. Exposed for tests and the start() tick. */
  runOnce: () => Promise<void>;
}

/** The minute key `YYYY-MM-DDTHH:MM` a moment falls in, for the run guard. */
function minuteKey(date: Date): string {
  return (
    `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` +
    `T${date.getHours()}:${date.getMinutes()}`
  );
}

export function createCronScheduler(options: CronSchedulerOptions): CronScheduler {
  const tickIntervalMs = options.tickIntervalMs ?? 30_000;
  const now = options.now ?? (() => new Date());
  const setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle) => clearInterval(handle as unknown as NodeJS.Timeout));

  // Guards against running a job twice within the same clock minute — the
  // tick interval is sub-minute on purpose, so without this a job due at
  // 03:00 would fire on every tick between 03:00:00 and 03:00:59. Keyed by
  // job id → the last minute it ran in.
  const lastRunMinute = new Map<number, string>();

  // Jobs currently executing, so a slow command (up to its timeout) can't be
  // started again by the next tick.
  const inFlight = new Set<number>();

  let timerHandle: unknown = null;

  async function considerJob(job: StoredCronJob, at: Date, key: string): Promise<void> {
    const parsed = parseCronExpression(job.cronExpression);
    if (!parsed.ok) {
      // A job with a broken expression can't have been saved through the
      // API (which validates), but a hand-edited database could produce one
      // — log it and skip rather than crash the whole sweep.
      options.logger.warn(
        { cronJobId: job.id, expression: job.cronExpression, error: parsed.error },
        "Skipping cron job with an unparseable expression"
      );
      return;
    }

    if (!cronMatches(parsed.parsed, at)) {
      return;
    }

    if (lastRunMinute.get(job.id) === key || inFlight.has(job.id)) {
      return;
    }

    lastRunMinute.set(job.id, key);
    inFlight.add(job.id);

    options.logger.info(
      { cronJobId: job.id, name: job.name, app: job.appName },
      "Running scheduled cron job"
    );

    try {
      const result = await runCronJob(options.dockerOps, job, now);
      options.repository.recordCronJobRun(job.id, result);
    } catch (error) {
      // runCronJob itself never throws, but recordCronJobRun touches the
      // DB — a failure there must not take down the scheduler loop.
      options.logger.error(
        { cronJobId: job.id, error: error instanceof Error ? error.message : "unknown" },
        "Failed to record a cron job run"
      );
    } finally {
      inFlight.delete(job.id);
    }
  }

  async function runOnce(): Promise<void> {
    const at = now();
    const key = minuteKey(at);

    let jobs: StoredCronJob[];
    try {
      jobs = options.repository.listEnabledCronJobs();
    } catch (error) {
      options.logger.error(
        { error: error instanceof Error ? error.message : "unknown" },
        "Cron scheduler failed to list jobs"
      );
      return;
    }

    // Sequential rather than parallel — one command per tick keeps a burst
    // of jobs from stampeding a small host, matching the auto-deploy poller.
    for (const job of jobs) {
      await considerJob(job, at, key);
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
