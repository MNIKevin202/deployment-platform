import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRetentionScheduler } from "../services/retention-scheduler.js";
import type { RetentionCleanupResult } from "../services/deployment-retention-service.js";

function summary(overrides: Partial<RetentionCleanupResult> = {}): RetentionCleanupResult {
  return {
    scope: "global",
    appId: null,
    skipped: false,
    versionsPruned: 0,
    imagesDeleted: 0,
    imagesRetained: 0,
    containersRemoved: 0,
    bytesReclaimed: 0,
    durationMs: 1,
    failures: [],
    ...overrides
  };
}

function silentLogger() {
  const errors: unknown[] = [];
  return {
    logger: {
      info: () => undefined,
      error: (obj: unknown) => errors.push(obj)
    },
    errors
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("createRetentionScheduler", () => {
  test("runs the sweep on the first run and records the timestamp", async () => {
    let lastRun: number | null = null;
    let runs = 0;
    const { logger } = silentLogger();

    const scheduler = createRetentionScheduler({
      getLastRunAt: () => lastRun,
      setLastRunAt: (ms) => {
        lastRun = ms;
      },
      runSweep: async () => {
        runs += 1;
        return summary();
      },
      logger,
      now: () => new Date(1_000_000)
    });

    await scheduler.runOnce();
    assert.equal(runs, 1);
    assert.equal(lastRun, 1_000_000);
  });

  test("does not run again before the interval elapses", async () => {
    let runs = 0;
    const { logger } = silentLogger();
    const scheduler = createRetentionScheduler({
      getLastRunAt: () => 1_000_000,
      setLastRunAt: () => undefined,
      runSweep: async () => {
        runs += 1;
        return summary();
      },
      logger,
      now: () => new Date(1_000_000 + DAY_MS - 1) // just under a day
    });

    await scheduler.runOnce();
    assert.equal(runs, 0);
  });

  test("runs again once the interval has elapsed", async () => {
    let runs = 0;
    const { logger } = silentLogger();
    const scheduler = createRetentionScheduler({
      getLastRunAt: () => 1_000_000,
      setLastRunAt: () => undefined,
      runSweep: async () => {
        runs += 1;
        return summary();
      },
      logger,
      now: () => new Date(1_000_000 + DAY_MS + 1)
    });

    await scheduler.runOnce();
    assert.equal(runs, 1);
  });

  test("logs when a sweep completes with failures", async () => {
    const { logger, errors } = silentLogger();
    const scheduler = createRetentionScheduler({
      getLastRunAt: () => null,
      setLastRunAt: () => undefined,
      runSweep: async () => summary({ failures: ["remove image x: boom"] }),
      logger,
      now: () => new Date(0)
    });

    await scheduler.runOnce();
    assert.equal(errors.length, 1);
  });

  test("start() wires the tick and stop() clears it", async () => {
    let handler: (() => void) | null = null;
    let cleared = false;
    const { logger } = silentLogger();

    const scheduler = createRetentionScheduler({
      getLastRunAt: () => null,
      setLastRunAt: () => undefined,
      runSweep: async () => summary(),
      logger,
      setIntervalFn: (fn) => {
        handler = fn;
        return 1;
      },
      clearIntervalFn: () => {
        cleared = true;
      }
    });

    scheduler.start();
    assert.equal(typeof handler, "function");
    scheduler.stop();
    assert.equal(cleared, true);
  });
});
