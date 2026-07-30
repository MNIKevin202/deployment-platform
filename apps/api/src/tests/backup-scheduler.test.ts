import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBackupScheduler, type AutoBackupConfig } from "../services/backup-scheduler.js";

const silentLogger = { info: () => {}, error: () => {} };

interface Harness {
  config: AutoBackupConfig;
  lastRunAt: number | null;
  runs: number;
  nowMs: number;
}

function makeScheduler(state: Harness) {
  return createBackupScheduler({
    getConfig: () => state.config,
    getLastRunAt: () => state.lastRunAt,
    setLastRunAt: (ms) => {
      state.lastRunAt = ms;
    },
    runBackup: async () => {
      state.runs += 1;
    },
    logger: silentLogger,
    now: () => new Date(state.nowMs)
  });
}

describe("createBackupScheduler", () => {
  test("does nothing when disabled", async () => {
    const state: Harness = { config: { enabled: false, intervalHours: 24, retention: 7 }, lastRunAt: null, runs: 0, nowMs: 0 };
    await makeScheduler(state).runOnce();
    assert.equal(state.runs, 0);
  });

  test("runs and records the time when enabled with no prior run", async () => {
    const state: Harness = { config: { enabled: true, intervalHours: 24, retention: 7 }, lastRunAt: null, runs: 0, nowMs: 1000 };
    await makeScheduler(state).runOnce();
    assert.equal(state.runs, 1);
    assert.equal(state.lastRunAt, 1000);
  });

  test("skips when the last run is within the interval", async () => {
    const hour = 60 * 60 * 1000;
    const state: Harness = {
      config: { enabled: true, intervalHours: 24, retention: 7 },
      lastRunAt: 0,
      runs: 0,
      nowMs: 12 * hour
    };
    await makeScheduler(state).runOnce();
    assert.equal(state.runs, 0);
  });

  test("runs again once the interval has elapsed", async () => {
    const hour = 60 * 60 * 1000;
    const state: Harness = {
      config: { enabled: true, intervalHours: 24, retention: 7 },
      lastRunAt: 0,
      runs: 0,
      nowMs: 25 * hour
    };
    await makeScheduler(state).runOnce();
    assert.equal(state.runs, 1);
    assert.equal(state.lastRunAt, 25 * hour);
  });
});
