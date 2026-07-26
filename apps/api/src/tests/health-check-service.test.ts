import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import {
  computeNextHealthState,
  performHealthCheck,
  createHealthCheckScheduler,
  type HealthCheckHttpClient,
  type HealthCheckHttpRequestOptions,
  type HealthCheckHttpResponse,
  type SchedulerTimerHandle
} from "../services/health-check-service.js";
import type { RecordEventFn, RecordEventInput } from "../services/deployment-event-service.js";

/**
 * A minimally-typed deferred promise for tests that need to hold a fake
 * HTTP request open and release it later. `resolve` is typed directly as
 * `(value: T) => void` — never `T | null` — and assigned via a definite
 * assignment assertion, since the Promise executor runs synchronously
 * during construction and always assigns it before `createDeferred`
 * returns. This sidesteps a TypeScript control-flow limitation where a
 * `let` resolver variable initialized to `null` and only ever reassigned
 * inside a nested closure gets narrowed to `never` at later call sites.
 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("computeNextHealthState", () => {
  test("flips to healthy only once the success threshold is reached", () => {
    assert.equal(
      computeNextHealthState({
        previousState: "unknown",
        success: true,
        consecutiveSuccesses: 1,
        consecutiveFailures: 0,
        successThreshold: 2,
        failureThreshold: 3
      }),
      "unknown"
    );

    assert.equal(
      computeNextHealthState({
        previousState: "unknown",
        success: true,
        consecutiveSuccesses: 2,
        consecutiveFailures: 0,
        successThreshold: 2,
        failureThreshold: 3
      }),
      "healthy"
    );
  });

  test("flips to unhealthy only once the failure threshold is reached", () => {
    assert.equal(
      computeNextHealthState({
        previousState: "healthy",
        success: false,
        consecutiveSuccesses: 0,
        consecutiveFailures: 1,
        successThreshold: 2,
        failureThreshold: 3
      }),
      "healthy"
    );

    assert.equal(
      computeNextHealthState({
        previousState: "healthy",
        success: false,
        consecutiveSuccesses: 0,
        consecutiveFailures: 3,
        successThreshold: 2,
        failureThreshold: 3
      }),
      "unhealthy"
    );
  });

  test("a healthy app stays labeled healthy while failures are still below threshold", () => {
    const state = computeNextHealthState({
      previousState: "healthy",
      success: false,
      consecutiveSuccesses: 0,
      consecutiveFailures: 1,
      successThreshold: 2,
      failureThreshold: 5
    });
    assert.equal(state, "healthy");
  });

  test("an unhealthy app stays labeled unhealthy while successes are still below threshold", () => {
    const state = computeNextHealthState({
      previousState: "unhealthy",
      success: true,
      consecutiveSuccesses: 1,
      consecutiveFailures: 0,
      successThreshold: 3,
      failureThreshold: 2
    });
    assert.equal(state, "unhealthy");
  });
});

type RequestCall = HealthCheckHttpRequestOptions;

function createFakeHttpClient(
  handler: (options: RequestCall) => Promise<{ statusCode: number; latencyMs: number }>
): { client: HealthCheckHttpClient; calls: RequestCall[] } {
  const calls: RequestCall[] = [];

  return {
    calls,
    client: {
      request: async (options) => {
        calls.push(options);
        return handler(options);
      }
    }
  };
}

function createEventTracker(): { recordEvent: RecordEventFn; events: RecordEventInput[] } {
  const events: RecordEventInput[] = [];
  return {
    events,
    recordEvent: (input) => {
      events.push(input);
    }
  };
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe("performHealthCheck", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-health-check-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeApp(name: string) {
    return appDatabase.createApp({
      name,
      image: "nginx:alpine",
      containerPort: 8080,
      containerName: `app-${name}`
    });
  }

  function configure(appId: number, overrides: Partial<Parameters<AppDatabase["upsertHealthConfig"]>[1]> = {}) {
    return appDatabase.upsertHealthConfig(appId, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2,
      ...overrides
    });
  }

  test("skips a health check for an app that no longer exists", async () => {
    const { client } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 5 }));
    const { recordEvent } = createEventTracker();

    const outcome = await performHealthCheck(
      {
        appDatabase,
        httpClient: client,
        isContainerRunning: async () => true,
        recordEvent,
        logger: noopLogger
      },
      999999
    );

    assert.equal(outcome.skipped, true);
    assert.equal(outcome.reason, "app-not-found");
  });

  test("skips a health check for an app with no configuration", async () => {
    const app = makeApp("app-unconfigured");
    const { client } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 5 }));
    const { recordEvent } = createEventTracker();

    const outcome = await performHealthCheck(
      {
        appDatabase,
        httpClient: client,
        isContainerRunning: async () => true,
        recordEvent,
        logger: noopLogger
      },
      app.id
    );

    assert.equal(outcome.skipped, true);
    assert.equal(outcome.reason, "not-configured");
  });

  test("marks the app container-not-running and never calls the HTTP client", async () => {
    const app = makeApp("app-stopped");
    configure(app.id);

    const { client, calls } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 5 }));
    const { recordEvent } = createEventTracker();

    const outcome = await performHealthCheck(
      {
        appDatabase,
        httpClient: client,
        isContainerRunning: async () => false,
        recordEvent,
        logger: noopLogger
      },
      app.id
    );

    assert.equal(outcome.state, "container-not-running");
    assert.equal(calls.length, 0);

    const config = appDatabase.getAppHealthCheck(app.id);
    assert.equal(config?.state, "container-not-running");
  });

  test("a successful check that reaches the success threshold transitions to healthy and fires an event", async () => {
    const app = makeApp("app-healthy");
    configure(app.id, { successThreshold: 2 });

    const { client } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 12 }));
    const { recordEvent, events } = createEventTracker();

    const deps = {
      appDatabase,
      httpClient: client,
      isContainerRunning: async () => true,
      recordEvent,
      logger: noopLogger
    };

    const first = await performHealthCheck(deps, app.id);
    assert.equal(first.state, "unknown");
    assert.equal(events.length, 0);

    const second = await performHealthCheck(deps, app.id);
    assert.equal(second.state, "healthy");
    assert.equal(events.some((e) => e.eventType === "health-became-healthy"), true);

    const config = appDatabase.getAppHealthCheck(app.id);
    assert.equal(config?.lastStatusCode, 200);
    assert.equal(config?.consecutiveSuccesses, 2);
  });

  test("an unexpected status code counts as a failure", async () => {
    const app = makeApp("app-wrong-status");
    configure(app.id, { failureThreshold: 1, expectedStatus: 200 });

    const { client } = createFakeHttpClient(async () => ({ statusCode: 500, latencyMs: 8 }));
    const { recordEvent } = createEventTracker();

    const outcome = await performHealthCheck(
      { appDatabase, httpClient: client, isContainerRunning: async () => true, recordEvent, logger: noopLogger },
      app.id
    );

    assert.equal(outcome.state, "unhealthy");
    const config = appDatabase.getAppHealthCheck(app.id);
    assert.match(config?.lastError ?? "", /Unexpected status code 500/);
    assert.equal(config?.lastStatusCode, 500);
  });

  test("a timeout is treated as a failure with a sanitized error message", async () => {
    const app = makeApp("app-timeout");
    configure(app.id, { failureThreshold: 1 });

    const { client } = createFakeHttpClient(async () => {
      throw new Error("Health check timed out after 5000ms");
    });
    const { recordEvent } = createEventTracker();

    const outcome = await performHealthCheck(
      { appDatabase, httpClient: client, isContainerRunning: async () => true, recordEvent, logger: noopLogger },
      app.id
    );

    assert.equal(outcome.state, "unhealthy");
    const config = appDatabase.getAppHealthCheck(app.id);
    assert.match(config?.lastError ?? "", /timed out/);
    assert.equal(config?.lastStatusCode, null);
  });

  test("a connection failure is treated as a failure", async () => {
    const app = makeApp("app-conn-refused");
    configure(app.id, { failureThreshold: 1 });

    const { client } = createFakeHttpClient(async () => {
      throw new Error("connect ECONNREFUSED 172.18.0.5:8080");
    });
    const { recordEvent } = createEventTracker();

    const outcome = await performHealthCheck(
      { appDatabase, httpClient: client, isContainerRunning: async () => true, recordEvent, logger: noopLogger },
      app.id
    );

    assert.equal(outcome.state, "unhealthy");
  });

  test("does not fire a healthy/unhealthy event when the state doesn't actually change", async () => {
    const app = makeApp("app-stable");
    configure(app.id, { successThreshold: 1 });

    const { client } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 3 }));
    const { recordEvent, events } = createEventTracker();

    const deps = {
      appDatabase,
      httpClient: client,
      isContainerRunning: async () => true,
      recordEvent,
      logger: noopLogger
    };

    await performHealthCheck(deps, app.id);
    events.length = 0;
    await performHealthCheck(deps, app.id);

    assert.equal(events.length, 0);
  });

  test("never stores or forwards a response body — only status code and latency", async () => {
    const app = makeApp("app-no-body");
    configure(app.id, { successThreshold: 1 });

    const { client } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 9 }));
    const { recordEvent } = createEventTracker();

    await performHealthCheck(
      { appDatabase, httpClient: client, isContainerRunning: async () => true, recordEvent, logger: noopLogger },
      app.id
    );

    // The httpClient contract itself has no field for a response body, so
    // there is no code path through which one could reach the database —
    // verified here by confirming the stored row only has the documented
    // scalar columns.
    const config = appDatabase.getAppHealthCheck(app.id);
    assert.ok(config);
    assert.deepEqual(
      Object.keys(config as object).sort(),
      [
        "appId",
        "consecutiveFailures",
        "consecutiveSuccesses",
        "createdAt",
        "enabled",
        "expectedStatus",
        "failureThreshold",
        "intervalSeconds",
        "lastCheckedAt",
        "lastError",
        "lastFailureAt",
        "lastLatencyMs",
        "lastStatusCode",
        "lastSuccessAt",
        "path",
        "state",
        "successThreshold",
        "timeoutSeconds",
        "updatedAt"
      ].sort()
    );
  });

  test("only ever sends hostname/port/path/timeout to the HTTP client — no custom headers", async () => {
    const app = makeApp("app-request-shape");
    configure(app.id, { path: "/status" });

    const { client, calls } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 4 }));
    const { recordEvent } = createEventTracker();

    await performHealthCheck(
      { appDatabase, httpClient: client, isContainerRunning: async () => true, recordEvent, logger: noopLogger },
      app.id
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]).sort(), ["hostname", "path", "port", "timeoutMs"]);
    assert.equal(calls[0].hostname, "app-app-request-shape");
    assert.equal(calls[0].port, 8080);
    assert.equal(calls[0].path, "/status");
  });

  test("manual runCheckNow and a scheduled tick both drive the same performHealthCheck threshold progression", async () => {
    const app = makeApp("app-shared-logic");
    // A successThreshold above 1 is essential to this test: it's what lets
    // us observe two distinct, meaningful steps (increment, then
    // transition) instead of a single call trivially reaching "healthy"
    // and masking whether the two entry points actually share state.
    configure(app.id, { successThreshold: 2 });

    const { client } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 2 }));
    const { recordEvent } = createEventTracker();

    const scheduler = createHealthCheckScheduler({
      appDatabase,
      httpClient: client,
      isContainerRunning: async () => true,
      recordEvent,
      logger: noopLogger,
      setIntervalFn: () => ({ unref: () => {} }),
      clearIntervalFn: () => {}
    });

    const flush = () => new Promise((resolve) => setImmediate(resolve));

    // First success via the scheduler's own tick path. The app has never
    // been checked before, so it's immediately due. One success is short
    // of the successThreshold of 2, so the counter advances but the state
    // stays "unknown" — this is the increment step.
    await scheduler.runTickOnce();
    await flush();

    const afterFirst = appDatabase.getAppHealthCheck(app.id);
    assert.equal(afterFirst?.state, "unknown");
    assert.equal(afterFirst?.consecutiveSuccesses, 1);

    // Second success via the manual "Run Check Now" path. runCheckNow()
    // bypasses the scheduler's due-time gate, but it calls the exact same
    // performHealthCheck() the tick above just used — so if the two entry
    // points shared no implementation, this call would restart from 0
    // successes instead of continuing from the 1 already recorded. It
    // reaching the threshold and transitioning to "healthy" is the proof
    // that both paths read and write the same stored counters/state.
    const manualOutcome = await scheduler.runCheckNow(app.id);

    assert.equal(manualOutcome.persisted, true);
    assert.equal(manualOutcome.state, "healthy");
    assert.equal(manualOutcome.changed, true);
    assert.equal(manualOutcome.statusCode, 200);
    assert.equal(manualOutcome.latencyMs, 2);

    const afterSecond = appDatabase.getAppHealthCheck(app.id);
    assert.equal(afterSecond?.state, "healthy");
    assert.equal(afterSecond?.consecutiveSuccesses, 2);
  });

  test("advances lastCheckedAt even when the container stays not-running (no state change)", async () => {
    const app = makeApp("app-stopped-repeat");
    configure(app.id);

    const { client, calls } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 5 }));
    const { recordEvent, events } = createEventTracker();

    const deps = {
      appDatabase,
      httpClient: client,
      isContainerRunning: async () => false,
      recordEvent,
      logger: noopLogger
    };

    const first = await performHealthCheck(deps, app.id);
    assert.equal(first.state, "container-not-running");
    assert.equal(first.changed, true);
    const firstCheckedAt = appDatabase.getAppHealthCheck(app.id)?.lastCheckedAt;
    assert.ok(firstCheckedAt);

    events.length = 0;

    // A short real delay so a second ISO timestamp is guaranteed to differ
    // from the first even at millisecond resolution.
    await new Promise((resolve) => setTimeout(resolve, 2));

    const second = await performHealthCheck(deps, app.id);
    assert.equal(second.state, "container-not-running");
    assert.equal(second.changed, false);

    const secondCheckedAt = appDatabase.getAppHealthCheck(app.id)?.lastCheckedAt;
    assert.ok(secondCheckedAt);
    assert.notEqual(secondCheckedAt, firstCheckedAt);

    // No HTTP calls ever happen while the container isn't running, and no
    // event fires for the second, unchanged check.
    assert.equal(calls.length, 0);
    assert.equal(events.length, 0);
  });

  test("a manual check against a disabled configuration runs a real probe but never persists a state change", async () => {
    const app = makeApp("app-disabled-manual");
    appDatabase.upsertHealthConfig(app.id, {
      enabled: false,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    const { client, calls } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 7 }));
    const { recordEvent, events } = createEventTracker();

    const outcome = await performHealthCheck(
      { appDatabase, httpClient: client, isContainerRunning: async () => true, recordEvent, logger: noopLogger },
      app.id
    );

    // The probe really ran...
    assert.equal(calls.length, 1);
    assert.equal(outcome.persisted, false);
    assert.equal(outcome.state, "healthy");
    assert.equal(outcome.statusCode, 200);
    assert.equal(outcome.latencyMs, 7);

    // ...but nothing was written: the row is exactly as it was.
    const config = appDatabase.getAppHealthCheck(app.id);
    assert.equal(config?.state, "disabled");
    assert.equal(config?.lastCheckedAt, null);
    assert.equal(config?.consecutiveSuccesses, 0);
    assert.equal(events.length, 0);
  });

  test("a manual check against a disabled configuration reports failure without persisting it either", async () => {
    const app = makeApp("app-disabled-manual-fail");
    appDatabase.upsertHealthConfig(app.id, {
      enabled: false,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    const { client } = createFakeHttpClient(async () => ({ statusCode: 500, latencyMs: 3 }));
    const { recordEvent } = createEventTracker();

    const outcome = await performHealthCheck(
      { appDatabase, httpClient: client, isContainerRunning: async () => true, recordEvent, logger: noopLogger },
      app.id
    );

    assert.equal(outcome.persisted, false);
    assert.equal(outcome.state, "unhealthy");
    assert.match(outcome.errorMessage ?? "", /Unexpected status code 500/);

    const config = appDatabase.getAppHealthCheck(app.id);
    assert.equal(config?.state, "disabled");
  });

  test("a manual check against a disabled configuration whose container isn't running still isn't persisted", async () => {
    const app = makeApp("app-disabled-manual-stopped");
    appDatabase.upsertHealthConfig(app.id, {
      enabled: false,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    const { client, calls } = createFakeHttpClient(async () => ({ statusCode: 200, latencyMs: 1 }));
    const { recordEvent } = createEventTracker();

    const outcome = await performHealthCheck(
      { appDatabase, httpClient: client, isContainerRunning: async () => false, recordEvent, logger: noopLogger },
      app.id
    );

    assert.equal(outcome.persisted, false);
    assert.equal(outcome.state, "container-not-running");
    assert.equal(calls.length, 0);

    const config = appDatabase.getAppHealthCheck(app.id);
    assert.equal(config?.state, "disabled");
    assert.equal(config?.lastCheckedAt, null);
  });
});

describe("createHealthCheckScheduler", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-health-scheduler-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeApp(name: string) {
    return appDatabase.createApp({
      name,
      image: "nginx:alpine",
      containerPort: 8080,
      containerName: `app-${name}`
    });
  }

  test("does not run two overlapping checks for the same app", async () => {
    const app = makeApp("app-overlap");
    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    let inFlightCount = 0;
    let maxObservedConcurrency = 0;
    const firstRequest = createDeferred<HealthCheckHttpResponse>();

    const client: HealthCheckHttpClient = {
      request: () => {
        inFlightCount += 1;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlightCount);

        return firstRequest.promise.then((response) => {
          inFlightCount -= 1;
          return response;
        });
      }
    };

    const { recordEvent } = createEventTracker();

    const scheduler = createHealthCheckScheduler({
      appDatabase,
      httpClient: client,
      isContainerRunning: async () => true,
      recordEvent,
      logger: noopLogger,
      setIntervalFn: () => ({ unref: () => {} }),
      clearIntervalFn: () => {}
    });

    // Kick off the first tick — it will hang inside the HTTP request until released.
    void scheduler.runTickOnce();
    await new Promise((resolve) => setImmediate(resolve));

    // A second tick while the first is still in flight must not start another check.
    await scheduler.runTickOnce();

    assert.equal(maxObservedConcurrency, 1);

    firstRequest.resolve({ statusCode: 200, latencyMs: 1 });
    await new Promise((resolve) => setImmediate(resolve));
  });

  test("runCheckNow rejects while a check for the same app is already in progress", async () => {
    const app = makeApp("app-manual-overlap");
    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    const pendingRequest = createDeferred<HealthCheckHttpResponse>();

    const client: HealthCheckHttpClient = {
      request: () => pendingRequest.promise
    };

    const { recordEvent } = createEventTracker();

    const scheduler = createHealthCheckScheduler({
      appDatabase,
      httpClient: client,
      isContainerRunning: async () => true,
      recordEvent,
      logger: noopLogger,
      setIntervalFn: () => ({ unref: () => {} }),
      clearIntervalFn: () => {}
    });

    const firstCall = scheduler.runCheckNow(app.id);
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(() => scheduler.runCheckNow(app.id), /already in progress/);

    pendingRequest.resolve({ statusCode: 200, latencyMs: 1 });
    await firstCall;
  });

  test("start() installs one centralized timer (not one per app) and unrefs it", () => {
    let handlerRef: (() => void) | null = null;
    let unrefCalled = false;
    let installCount = 0;

    const fakeHandle: SchedulerTimerHandle = {
      unref: () => {
        unrefCalled = true;
      }
    };

    const { recordEvent } = createEventTracker();

    const scheduler = createHealthCheckScheduler({
      appDatabase,
      httpClient: { request: async () => ({ statusCode: 200, latencyMs: 1 }) },
      isContainerRunning: async () => true,
      recordEvent,
      logger: noopLogger,
      setIntervalFn: (handler) => {
        installCount += 1;
        handlerRef = handler;
        return fakeHandle;
      },
      clearIntervalFn: () => {}
    });

    scheduler.start();

    assert.equal(installCount, 1);
    assert.equal(unrefCalled, true);
    assert.ok(handlerRef);

    // Calling start() again must not install a second timer.
    scheduler.start();
    assert.equal(installCount, 1);
  });

  test("stop() clears the timer for an orderly shutdown", () => {
    let clearedWith: SchedulerTimerHandle | null = null;
    const fakeHandle: SchedulerTimerHandle = { unref: () => {} };

    const { recordEvent } = createEventTracker();

    const scheduler = createHealthCheckScheduler({
      appDatabase,
      httpClient: { request: async () => ({ statusCode: 200, latencyMs: 1 }) },
      isContainerRunning: async () => true,
      recordEvent,
      logger: noopLogger,
      setIntervalFn: () => fakeHandle,
      clearIntervalFn: (handle) => {
        clearedWith = handle;
      }
    });

    scheduler.start();
    scheduler.stop();

    assert.equal(clearedWith, fakeHandle);

    // Calling stop() again is a harmless no-op.
    assert.doesNotThrow(() => scheduler.stop());
  });

  test("a stopped app is rechecked only after its configured interval, not on every scheduler tick", async () => {
    const app = makeApp("app-stopped-interval");
    appDatabase.upsertHealthConfig(app.id, {
      enabled: true,
      path: "/health",
      expectedStatus: 200,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 3,
      successThreshold: 2
    });

    let currentTimeMs = new Date("2026-01-01T00:00:00.000Z").getTime();
    const now = () => new Date(currentTimeMs);

    let runningCheckCount = 0;
    const { recordEvent } = createEventTracker();

    const scheduler = createHealthCheckScheduler({
      appDatabase,
      httpClient: { request: async () => ({ statusCode: 200, latencyMs: 1 }) },
      isContainerRunning: async () => {
        runningCheckCount += 1;
        return false;
      },
      recordEvent,
      logger: noopLogger,
      now,
      setIntervalFn: () => ({ unref: () => {} }),
      clearIntervalFn: () => {}
    });

    const flush = () => new Promise((resolve) => setImmediate(resolve));

    // 1. First tick: never checked before, so it's checked immediately.
    await scheduler.runTickOnce();
    await flush();
    assert.equal(runningCheckCount, 1);

    const afterFirst = appDatabase.getAppHealthCheck(app.id);
    assert.equal(afterFirst?.state, "container-not-running");
    // 2. lastCheckedAt advances to the (fake) current time.
    assert.equal(afterFirst?.lastCheckedAt, now().toISOString());

    // 3. Ticks before the 30s interval has elapsed must not check again —
    // this is the regression this test exists to catch: a stopped app
    // must not become due on every 5-second scheduler tick.
    currentTimeMs += 5000;
    await scheduler.runTickOnce();
    await flush();
    assert.equal(runningCheckCount, 1);
    assert.equal(appDatabase.getAppHealthCheck(app.id)?.lastCheckedAt, afterFirst?.lastCheckedAt);

    currentTimeMs += 10000; // 15s total — still short of the 30s interval
    await scheduler.runTickOnce();
    await flush();
    assert.equal(runningCheckCount, 1);

    // 4. Once the full interval has elapsed, the next tick checks it again.
    currentTimeMs += 20000; // 35s total — past the 30s interval
    await scheduler.runTickOnce();
    await flush();
    assert.equal(runningCheckCount, 2);
    assert.equal(appDatabase.getAppHealthCheck(app.id)?.lastCheckedAt, now().toISOString());
  });
});
