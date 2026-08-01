import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runCronJob, type CronDockerOps } from "../services/cron-executor-service.js";
import type { StoredCronJob } from "../cron-job-database.js";

function job(overrides: Partial<StoredCronJob> = {}): StoredCronJob {
  return {
    id: 1,
    appId: 10,
    appName: "web",
    containerName: "app-web",
    name: "nightly cleanup",
    cronExpression: "0 3 * * *",
    command: "php artisan cleanup",
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

const fixedNow = () => new Date("2026-08-01T03:00:00Z");

describe("runCronJob", () => {
  test("a zero exit code is recorded as success with its output", async () => {
    const dockerOps: CronDockerOps = {
      async execCommand() {
        return { exitCode: 0, output: "cleaned 42 rows\n", timedOut: false };
      }
    };

    const result = await runCronJob(dockerOps, job(), fixedNow);
    assert.equal(result.status, "success");
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /cleaned 42 rows/);
    assert.equal(result.ranAt, "2026-08-01T03:00:00.000Z");
  });

  test("a non-zero exit code is a failure, not a crash", async () => {
    const dockerOps: CronDockerOps = {
      async execCommand() {
        return { exitCode: 1, output: "error: table missing\n", timedOut: false };
      }
    };

    const result = await runCronJob(dockerOps, job(), fixedNow);
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
  });

  test("a timed-out command is recorded as timeout", async () => {
    const dockerOps: CronDockerOps = {
      async execCommand() {
        return { exitCode: 124, output: "partial…", timedOut: true };
      }
    };

    const result = await runCronJob(dockerOps, job(), fixedNow);
    assert.equal(result.status, "timeout");
    assert.equal(result.exitCode, null);
  });

  test("a job whose app has no container is skipped, never run", async () => {
    let called = false;
    const dockerOps: CronDockerOps = {
      async execCommand() {
        called = true;
        return { exitCode: 0, output: "", timedOut: false };
      }
    };

    const result = await runCronJob(dockerOps, job({ containerName: null }), fixedNow);
    assert.equal(result.status, "skipped");
    assert.equal(called, false, "the executor is never invoked without a container");
  });

  test("a vanished container (404) is a skip, not a failure", async () => {
    const dockerOps: CronDockerOps = {
      async execCommand() {
        throw Object.assign(new Error("no such container"), { statusCode: 404 });
      }
    };

    const result = await runCronJob(dockerOps, job(), fixedNow);
    assert.equal(result.status, "skipped");
    assert.match(result.output, /no longer exists/i);
  });

  test("an unexpected Docker error is reported as a failure, never thrown", async () => {
    const dockerOps: CronDockerOps = {
      async execCommand() {
        throw new Error("docker daemon unreachable");
      }
    };

    const result = await runCronJob(dockerOps, job(), fixedNow);
    assert.equal(result.status, "failed");
    assert.match(result.output, /docker daemon unreachable/);
  });

  test("the command is passed through verbatim to the executor", async () => {
    let seen: { container: string; command: string; timeoutMs: number } | null = null;
    const dockerOps: CronDockerOps = {
      async execCommand(container, command, timeoutMs) {
        seen = { container, command, timeoutMs };
        return { exitCode: 0, output: "", timedOut: false };
      }
    };

    await runCronJob(
      dockerOps,
      job({ command: "rails db:migrate", containerName: "app-web", timeoutSeconds: 45 }),
      fixedNow
    );

    assert.deepEqual(seen, {
      container: "app-web",
      command: "rails db:migrate",
      timeoutMs: 45_000
    });
  });
});
