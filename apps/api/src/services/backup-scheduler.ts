export interface AutoBackupConfig {
  enabled: boolean;
  intervalHours: number;
  retention: number;
}

export interface BackupSchedulerLogger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface BackupSchedulerOptions {
  getConfig: () => AutoBackupConfig;
  getLastRunAt: () => number | null;
  setLastRunAt: (ms: number) => void;
  /** Creates a scheduled backup (write to disk + retention). */
  runBackup: () => Promise<void>;
  logger: BackupSchedulerLogger;
  /** How often to check whether a backup is due. Defaults to hourly. */
  tickIntervalMs?: number;
  now?: () => Date;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface BackupScheduler {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<void>;
}

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const tickIntervalMs = options.tickIntervalMs ?? 60 * 60 * 1000;
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

    const config = options.getConfig();
    if (!config.enabled) {
      return;
    }

    const lastRunAt = options.getLastRunAt();
    const dueAfterMs = Math.max(1, config.intervalHours) * 60 * 60 * 1000;
    if (lastRunAt !== null && now().getTime() - lastRunAt < dueAfterMs) {
      return;
    }

    inFlight = true;
    try {
      await options.runBackup();
      options.setLastRunAt(now().getTime());
      options.logger.info({}, "Scheduled backup completed");
    } catch (error) {
      options.logger.error(
        { error: error instanceof Error ? error.message : "unknown" },
        "Scheduled backup failed"
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
