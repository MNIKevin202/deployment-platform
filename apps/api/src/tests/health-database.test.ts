import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("app health checks (database layer)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-health-db-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
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

  test("returns null when no config exists yet", () => {
    const app = makeApp("app-one");
    assert.equal(appDatabase.getAppHealthCheck(app.id), null);
    cleanup();
  });

  test("upsertHealthConfig creates a row with a disabled/unknown starting state matching enabled", () => {
    const app = makeApp("app-two");

    const disabledConfig = appDatabase.upsertHealthConfig(app.id, {
      enabled: false,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    assert.equal(disabledConfig.state, "disabled");
    assert.equal(disabledConfig.enabled, false);

    cleanup();
  });

  test("upsertHealthConfig starts an enabled config as unknown", () => {
    const app = makeApp("app-three");

    const config = appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    assert.equal(config.state, "unknown");

    cleanup();
  });

  test("upsertHealthConfig preserves state and counters when only timing settings change", () => {
    const app = makeApp("app-four");

    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    appDatabase.updateHealthState(app.id, {
      state: "healthy",
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      consecutiveSuccesses: 5
    });

    // Only interval/timeout change — path, expected status, and thresholds
    // are identical, so the counters are still measuring the same thing.
    const updated = appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 60,
      timeoutSeconds: 10,
      failureThreshold: 3,
      successThreshold: 2
    });

    assert.equal(updated.intervalSeconds, 60);
    assert.equal(updated.timeoutSeconds, 10);
    assert.equal(updated.state, "healthy");
    assert.equal(updated.consecutiveSuccesses, 5);

    cleanup();
  });

  test("upsertHealthConfig resets counters (but keeps the settled state) when path/expected-status/thresholds change while staying enabled", () => {
    const app = makeApp("app-four-criteria");

    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    appDatabase.updateHealthState(app.id, {
      state: "healthy",
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      consecutiveSuccesses: 5,
      consecutiveFailures: 0
    });

    // The check target itself changes — the old counters were measured
    // against the old path/status/thresholds and would misrepresent
    // progress under the new ones.
    const updated = appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/status",
      expectedStatus: 204,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 4,
      successThreshold: 3
    });

    assert.equal(updated.path, "/status");
    assert.equal(updated.expectedStatus, 204);
    assert.equal(updated.consecutiveSuccesses, 0);
    assert.equal(updated.consecutiveFailures, 0);
    // The settled "healthy" verdict itself is preserved — only the
    // in-progress counters reset.
    assert.equal(updated.state, "healthy");

    cleanup();
  });

  test("upsertHealthConfig transitions healthy -> disabled: state becomes disabled, counters reset, no event required", () => {
    const app = makeApp("app-healthy-to-disabled");

    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    appDatabase.updateHealthState(app.id, {
      state: "healthy",
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      lastSuccessAt: "2026-01-01T00:00:00.000Z",
      consecutiveSuccesses: 5,
      consecutiveFailures: 0,
      lastStatusCode: 200,
      lastLatencyMs: 12
    });

    const disabled = appDatabase.upsertHealthConfig(app.id, {
      enabled: false,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    assert.equal(disabled.enabled, false);
    assert.equal(disabled.state, "disabled");
    assert.equal(disabled.consecutiveSuccesses, 0);
    assert.equal(disabled.consecutiveFailures, 0);
    // Historical context survives for the operator.
    assert.equal(disabled.lastSuccessAt, "2026-01-01T00:00:00.000Z");
    assert.equal(disabled.lastStatusCode, 200);

    cleanup();
  });

  test("upsertHealthConfig transitions unhealthy -> disabled: state becomes disabled, counters and lastError reset", () => {
    const app = makeApp("app-unhealthy-to-disabled");

    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    appDatabase.updateHealthState(app.id, {
      state: "unhealthy",
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      lastFailureAt: "2026-01-01T00:00:00.000Z",
      consecutiveFailures: 4,
      consecutiveSuccesses: 0,
      lastError: "Unexpected status code 500 (expected 200)"
    });

    const disabled = appDatabase.upsertHealthConfig(app.id, {
      enabled: false,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    assert.equal(disabled.state, "disabled");
    assert.equal(disabled.consecutiveFailures, 0);
    assert.equal(disabled.lastError, null);
    // Historical failure timestamp still survives for operator context.
    assert.equal(disabled.lastFailureAt, "2026-01-01T00:00:00.000Z");

    cleanup();
  });

  test("upsertHealthConfig transitions disabled -> enabled: state becomes unknown, counters reset, immediately due", () => {
    const app = makeApp("app-disabled-to-enabled");

    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    appDatabase.updateHealthState(app.id, {
      state: "healthy",
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      consecutiveSuccesses: 5
    });

    appDatabase.upsertHealthConfig(app.id, {
      enabled: false,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    // Re-enabling must never reuse the stale "healthy" verdict from before
    // it was turned off.
    const reEnabled = appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    assert.equal(reEnabled.enabled, true);
    assert.equal(reEnabled.state, "unknown");
    assert.equal(reEnabled.consecutiveSuccesses, 0);
    assert.equal(reEnabled.consecutiveFailures, 0);
    // Cleared so the scheduler's isDue() treats it as immediately due
    // rather than waiting out the interval from its last (stale) check.
    assert.equal(reEnabled.lastCheckedAt, null);

    cleanup();
  });

  test("upsertHealthConfig leaves an already-disabled config inert when saved again while still disabled", () => {
    const app = makeApp("app-stay-disabled");

    appDatabase.upsertHealthConfig(app.id, {
      enabled: false,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    const updated = appDatabase.upsertHealthConfig(app.id, {
      enabled: false,
      path: "/status",
      expectedStatus: 204,
      intervalSeconds: 60,
      timeoutSeconds: 10,
      failureThreshold: 4,
      successThreshold: 3
    });

    assert.equal(updated.enabled, false);
    assert.equal(updated.state, "disabled");
    assert.equal(updated.path, "/status");

    cleanup();
  });

  test("updateHealthState throws for an app with no configured health check", () => {
    const app = makeApp("app-five");

    assert.throws(() => {
      appDatabase.updateHealthState(app.id, { state: "healthy" });
    });

    cleanup();
  });

  test("updateHealthState updates only the provided fields, leaving others intact", () => {
    const app = makeApp("app-six");

    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    appDatabase.updateHealthState(app.id, {
      state: "healthy",
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      lastStatusCode: 200,
      lastLatencyMs: 42,
      consecutiveSuccesses: 2
    });

    appDatabase.updateHealthState(app.id, {
      state: "unhealthy",
      lastCheckedAt: "2026-01-01T00:01:00.000Z",
      consecutiveFailures: 1
    });

    const final = appDatabase.getAppHealthCheck(app.id);
    assert.equal(final?.state, "unhealthy");
    // Untouched fields from the previous write are preserved.
    assert.equal(final?.lastStatusCode, 200);
    assert.equal(final?.lastLatencyMs, 42);

    cleanup();
  });

  test("listEnabledHealthChecks only returns rows with enabled = true", () => {
    const enabledApp = makeApp("app-seven");
    const disabledApp = makeApp("app-eight");

    appDatabase.upsertHealthConfig(enabledApp.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    appDatabase.upsertHealthConfig(disabledApp.id, {
      enabled: false,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    const enabled = appDatabase.listEnabledHealthChecks();
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].appId, enabledApp.id);

    cleanup();
  });

  test("cascades health check deletion when the owning app is deleted", () => {
    const app = makeApp("app-nine");

    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    appDatabase.deleteApp(app.id);

    assert.equal(appDatabase.getAppHealthCheck(app.id), null);

    cleanup();
  });
});
