import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("cron jobs (database layer)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-cron-db-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
  });

  function cleanup() {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  function makeApp(name: string) {
    return appDatabase.createApp({
      name,
      image: "nginx:alpine",
      containerPort: 80,
      containerName: `app-${name}`
    });
  }

  test("create → list joins the app name and container name", () => {
    const app = makeApp("web-one");
    const job = appDatabase.createCronJob({
      appId: app.id,
      name: "nightly",
      cronExpression: "0 3 * * *",
      command: "php artisan cleanup",
      enabled: true,
      timeoutSeconds: 120
    });

    assert.equal(job.appName, "web-one");
    assert.equal(job.containerName, "app-web-one");
    assert.equal(job.enabled, true);
    assert.equal(job.timeoutSeconds, 120);

    const listed = appDatabase.listCronJobs();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, job.id);
    cleanup();
  });

  test("listEnabledCronJobs returns only the enabled ones", () => {
    const app = makeApp("web-two");
    appDatabase.createCronJob({
      appId: app.id, name: "on", cronExpression: "* * * * *", command: "a", enabled: true, timeoutSeconds: 60
    });
    appDatabase.createCronJob({
      appId: app.id, name: "off", cronExpression: "* * * * *", command: "b", enabled: false, timeoutSeconds: 60
    });

    const enabled = appDatabase.listEnabledCronJobs();
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].name, "on");
    cleanup();
  });

  test("update changes fields; delete removes the row", () => {
    const app = makeApp("web-three");
    const job = appDatabase.createCronJob({
      appId: app.id, name: "orig", cronExpression: "0 3 * * *", command: "a", enabled: true, timeoutSeconds: 60
    });

    const updated = appDatabase.updateCronJob(job.id, {
      name: "renamed", cronExpression: "0 4 * * *", command: "b", enabled: false, timeoutSeconds: 90
    });
    assert.equal(updated?.name, "renamed");
    assert.equal(updated?.cronExpression, "0 4 * * *");
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.timeoutSeconds, 90);

    assert.equal(appDatabase.deleteCronJob(job.id), true);
    assert.equal(appDatabase.getCronJob(job.id), null);
    assert.equal(appDatabase.deleteCronJob(job.id), false, "deleting again is a no-op");
    cleanup();
  });

  test("recordCronJobRun stores the last-run summary", () => {
    const app = makeApp("web-four");
    const job = appDatabase.createCronJob({
      appId: app.id, name: "j", cronExpression: "0 3 * * *", command: "a", enabled: true, timeoutSeconds: 60
    });

    appDatabase.recordCronJobRun(job.id, {
      status: "success",
      exitCode: 0,
      output: "done",
      durationMs: 1234,
      ranAt: "2026-08-01T03:00:00.000Z"
    });

    const after = appDatabase.getCronJob(job.id);
    assert.equal(after?.lastStatus, "success");
    assert.equal(after?.lastExitCode, 0);
    assert.equal(after?.lastOutput, "done");
    assert.equal(after?.lastDurationMs, 1234);
    assert.equal(after?.lastRunAt, "2026-08-01T03:00:00.000Z");

    // The same call also appends to the run history.
    const runs = appDatabase.listCronJobRuns(job.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "success");
    assert.equal(runs[0].exitCode, 0);
    assert.equal(runs[0].output, "done");
    assert.equal(runs[0].durationMs, 1234);
    assert.equal(runs[0].ranAt, "2026-08-01T03:00:00.000Z");
    cleanup();
  });

  test("run history is newest-first and only for the given job", () => {
    const app = makeApp("web-history");
    const jobA = appDatabase.createCronJob({
      appId: app.id, name: "a", cronExpression: "0 3 * * *", command: "a", enabled: true, timeoutSeconds: 60
    });
    const jobB = appDatabase.createCronJob({
      appId: app.id, name: "b", cronExpression: "0 4 * * *", command: "b", enabled: true, timeoutSeconds: 60
    });

    appDatabase.recordCronJobRun(jobA.id, {
      status: "failed", exitCode: 1, output: "first", durationMs: 10, ranAt: "2026-08-01T03:00:00.000Z"
    });
    appDatabase.recordCronJobRun(jobA.id, {
      status: "success", exitCode: 0, output: "second", durationMs: 20, ranAt: "2026-08-01T03:01:00.000Z"
    });
    appDatabase.recordCronJobRun(jobB.id, {
      status: "success", exitCode: 0, output: "other job", durationMs: 5, ranAt: "2026-08-01T04:00:00.000Z"
    });

    const runsA = appDatabase.listCronJobRuns(jobA.id);
    assert.equal(runsA.length, 2);
    assert.equal(runsA[0].output, "second", "newest run is first");
    assert.equal(runsA[1].output, "first");

    const runsB = appDatabase.listCronJobRuns(jobB.id);
    assert.equal(runsB.length, 1);
    assert.equal(runsB[0].output, "other job");
    cleanup();
  });

  test("run history is capped and prunes the oldest runs", () => {
    const app = makeApp("web-cap");
    const job = appDatabase.createCronJob({
      appId: app.id, name: "j", cronExpression: "* * * * *", command: "a", enabled: true, timeoutSeconds: 60
    });

    // More than the 100-run cap; the oldest should be pruned as we go.
    for (let i = 0; i < 105; i += 1) {
      appDatabase.recordCronJobRun(job.id, {
        status: "success",
        exitCode: 0,
        output: `run-${i}`,
        durationMs: 1,
        ranAt: `2026-08-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`
      });
    }

    const runs = appDatabase.listCronJobRuns(job.id, 200);
    assert.equal(runs.length, 100, "history is capped at 100");
    assert.equal(runs[0].output, "run-104", "newest is kept");
    assert.equal(runs[runs.length - 1].output, "run-5", "oldest kept is run-5 (runs 0–4 pruned)");
    cleanup();
  });

  test("deleting the app cascades to its cron jobs", () => {
    const app = makeApp("web-five");
    const job = appDatabase.createCronJob({
      appId: app.id, name: "j", cronExpression: "0 3 * * *", command: "a", enabled: true, timeoutSeconds: 60
    });
    appDatabase.recordCronJobRun(job.id, {
      status: "success", exitCode: 0, output: "done", durationMs: 1, ranAt: "2026-08-01T03:00:00.000Z"
    });

    appDatabase.deleteApp(app.id);
    assert.equal(appDatabase.getCronJob(job.id), null, "the job is gone with its app");
    // The whole chain cascades: app → job → run history.
    assert.equal(appDatabase.listCronJobRuns(job.id).length, 0, "the run history is gone too");
    cleanup();
  });
});
