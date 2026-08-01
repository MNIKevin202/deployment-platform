import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCronScheduler } from "../services/cron-scheduler.js";
import type { CronDockerOps } from "../services/cron-executor-service.js";
import type { CronJobRunResult, StoredCronJob } from "../cron-job-database.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function job(overrides: Partial<StoredCronJob> = {}): StoredCronJob {
  return {
    id: 1,
    appId: 10,
    appName: "web",
    containerName: "app-web",
    name: "job",
    cronExpression: "0 3 * * *",
    command: "echo hi",
    enabled: true,
    timeoutSeconds: 60,
    lastRunAt: null,
    lastStatus: null,
    lastExitCode: null,
    lastOutput: null,
    lastDurationMs: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides
  };
}

/** A repository fake + a docker fake that records every exec. */
function harness(jobs: StoredCronJob[]) {
  const runs: Array<{ id: number }> = [];
  const recorded: Array<{ id: number; result: CronJobRunResult }> = [];

  const repository = {
    listEnabledCronJobs: () => jobs.filter((j) => j.enabled),
    recordCronJobRun: (id: number, result: CronJobRunResult) => recorded.push({ id, result })
  };

  const dockerOps: CronDockerOps = {
    async execCommand() {
      return { exitCode: 0, output: "ok", timedOut: false };
    }
  };

  return { runs, recorded, repository, dockerOps };
}

describe("createCronScheduler", () => {
  test("runs a job whose expression matches the current minute", async () => {
    const { repository, dockerOps, recorded } = harness([job({ cronExpression: "0 3 * * *" })]);
    const scheduler = createCronScheduler({
      repository,
      dockerOps,
      logger: silentLogger,
      now: () => new Date(2026, 7, 1, 3, 0)
    });

    await scheduler.runOnce();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].result.status, "success");
  });

  test("does nothing when no job matches the current minute", async () => {
    const { repository, dockerOps, recorded } = harness([job({ cronExpression: "0 3 * * *" })]);
    const scheduler = createCronScheduler({
      repository,
      dockerOps,
      logger: silentLogger,
      now: () => new Date(2026, 7, 1, 4, 0)
    });

    await scheduler.runOnce();
    assert.equal(recorded.length, 0);
  });

  test("never runs a matching job twice in the same minute across ticks", async () => {
    const { repository, dockerOps, recorded } = harness([job({ cronExpression: "0 3 * * *" })]);
    const scheduler = createCronScheduler({
      repository,
      dockerOps,
      logger: silentLogger,
      now: () => new Date(2026, 7, 1, 3, 0, 15) // same minute, later second
    });

    await scheduler.runOnce();
    await scheduler.runOnce();
    await scheduler.runOnce();

    assert.equal(recorded.length, 1, "the per-minute guard prevents repeats");
  });

  test("runs again in a later matching minute", async () => {
    let minute = 0;
    const { repository, dockerOps, recorded } = harness([job({ cronExpression: "* * * * *" })]);
    const scheduler = createCronScheduler({
      repository,
      dockerOps,
      logger: silentLogger,
      now: () => new Date(2026, 7, 1, 3, minute)
    });

    await scheduler.runOnce();
    minute = 1;
    await scheduler.runOnce();

    assert.equal(recorded.length, 2, "a new minute allows another run");
  });

  test("skips disabled jobs entirely", async () => {
    const { repository, dockerOps, recorded } = harness([
      job({ id: 1, enabled: false, cronExpression: "* * * * *" })
    ]);
    const scheduler = createCronScheduler({
      repository,
      dockerOps,
      logger: silentLogger,
      now: () => new Date(2026, 7, 1, 3, 0)
    });

    await scheduler.runOnce();
    assert.equal(recorded.length, 0);
  });

  test("a job with a broken expression is skipped, not fatal to the sweep", async () => {
    const { repository, dockerOps, recorded } = harness([
      job({ id: 1, cronExpression: "not a cron", command: "a" }),
      job({ id: 2, cronExpression: "* * * * *", command: "b" })
    ]);
    const scheduler = createCronScheduler({
      repository,
      dockerOps,
      logger: silentLogger,
      now: () => new Date(2026, 7, 1, 3, 0)
    });

    await scheduler.runOnce();
    // The good job still runs even though the broken one was in the list.
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].id, 2);
  });

  test("records the run result against the job", async () => {
    const { repository, dockerOps, recorded } = harness([job({ id: 7, cronExpression: "* * * * *" })]);
    const scheduler = createCronScheduler({
      repository,
      dockerOps,
      logger: silentLogger,
      now: () => new Date(2026, 7, 1, 3, 0)
    });

    await scheduler.runOnce();
    assert.equal(recorded[0].id, 7);
    assert.equal(recorded[0].result.status, "success");
  });
});
