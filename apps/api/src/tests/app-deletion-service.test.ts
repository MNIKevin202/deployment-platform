import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import {
  deleteAppWithIdempotency,
  type ContainerProtectionInfo,
  type DeletionDockerOps,
  type DeleteAppServiceDependencies
} from "../services/app-deletion-service.js";

/** A dockerode-shaped 404, matching what getErrorStatusCode() looks for. */
function notFoundError(): Error & { statusCode: number } {
  const error = new Error("no such container") as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}

interface FakeDockerState {
  containers: Map<string, ContainerProtectionInfo>;
}

interface FakeOpsCalls {
  inspected: string[];
  removed: string[];
}

function createFakeOps(state: FakeDockerState): { ops: DeletionDockerOps; calls: FakeOpsCalls } {
  const calls: FakeOpsCalls = { inspected: [], removed: [] };

  const ops: DeletionDockerOps = {
    async inspectForDeletion(id) {
      calls.inspected.push(id);
      const info = state.containers.get(id);
      if (!info) throw notFoundError();
      return info;
    },
    async removeContainer(id) {
      calls.removed.push(id);
      if (!state.containers.has(id)) throw notFoundError();
      state.containers.delete(id);
    }
  };

  return { ops, calls };
}

function managedAppContainer(appName: string, overrides: Partial<ContainerProtectionInfo> = {}): ContainerProtectionInfo {
  return {
    name: `app-${appName}`,
    labels: {
      "com.deployment-platform.managed": "true",
      "com.deployment-platform.app-name": appName
    },
    isSystemContainer: false,
    isManagedApp: true,
    ...overrides
  };
}

async function fakeReconcileSuccess() {
  return { lastReconcileSucceeded: true, lastError: null };
}

describe("deleteAppWithIdempotency", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let state: FakeDockerState;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-delete-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
    state = { containers: new Map() };
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedApp(name: string, containerId: string): void {
    appDatabase.createApp({
      name,
      image: "nginx:alpine",
      containerPort: 80,
      containerName: `app-${name}`,
      domain: `${name}.apps.example.com`
    });
    state.containers.set(containerId, managedAppContainer(name));
  }

  function deps(overrides: Partial<DeleteAppServiceDependencies> = {}): DeleteAppServiceDependencies {
    return {
      appDatabase,
      dockerOps: createFakeOps(state).ops,
      reconcileRouting: fakeReconcileSuccess,
      ...overrides
    };
  }

  test("deletes the container and the app record, and reconciles routing when it had a domain", async () => {
    seedApp("app-one", "container-1");
    let reconciled = 0;

    const result = await deleteAppWithIdempotency(
      deps({ reconcileRouting: async () => { reconciled += 1; return fakeReconcileSuccess(); } }),
      "container-1"
    );

    assert.equal(result.success, true);
    assert.equal(result.appName, "app-one");
    assert.equal(appDatabase.getAppByName("app-one"), null);
    assert.equal(state.containers.has("container-1"), false);
    assert.equal(reconciled, 1);
  });

  test("rejects deleting a system container", async () => {
    state.containers.set("api-container", managedAppContainer("x", { name: "deployment-platform-api", isSystemContainer: true, isManagedApp: false }));

    const result = await deleteAppWithIdempotency(deps(), "api-container");
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 403);
    assert.match(result.message, /System containers/);
    assert.equal(state.containers.has("api-container"), true);
  });

  test("rejects deleting a container the platform does not manage", async () => {
    state.containers.set("random-container", { name: "random", labels: {}, isSystemContainer: false, isManagedApp: false });

    const result = await deleteAppWithIdempotency(deps(), "random-container");
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 403);
    assert.match(result.message, /Only apps created by Deployment Platform/);
  });

  test("a genuinely unknown container id returns 404, no key involved", async () => {
    const result = await deleteAppWithIdempotency(deps(), "does-not-exist");
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 404);
  });

  describe("idempotency key handling", () => {
    test("a repeated request with the same key replays the original success, without a second Docker call", async () => {
      seedApp("idem-app", "container-idem");
      const { ops, calls } = createFakeOps(state);
      const d = deps({ dockerOps: ops });

      const first = await deleteAppWithIdempotency(d, "container-idem", "delete-key-1");
      assert.equal(first.success, true);
      assert.equal(calls.removed.length, 1);

      // Simulates the connection dropping after the server committed the
      // delete (the Caddy restart during routing reconciliation is exactly
      // this shape) and the same logical request being delivered again.
      const second = await deleteAppWithIdempotency(d, "container-idem", "delete-key-1");

      assert.equal(second.success, true);
      assert.deepEqual(second, first);
      // The operation actually ran only once.
      assert.equal(calls.removed.length, 1);
    });

    test("a different key against an already-deleted app is a real 404, never a fabricated success", async () => {
      seedApp("idem-app2", "container-idem2");
      const d = deps();

      const first = await deleteAppWithIdempotency(d, "container-idem2", "key-a");
      assert.equal(first.success, true);

      const second = await deleteAppWithIdempotency(d, "container-idem2", "key-b");
      assert.equal(second.success, false);
      assert.equal(second.statusCode, 404);
    });

    test("reusing a key against a different container id is rejected as a mismatch, never replayed", async () => {
      seedApp("idem-a", "container-a");
      seedApp("idem-b", "container-b");
      const d = deps();
      const key = "reused-delete-key";

      const first = await deleteAppWithIdempotency(d, "container-a", key);
      assert.equal(first.success, true);

      const second = await deleteAppWithIdempotency(d, "container-b", key);
      assert.equal(second.success, false);
      assert.equal(second.statusCode, 409);
      assert.match(second.message, /different request/);
      // container-b was never touched.
      assert.equal(state.containers.has("container-b"), true);
    });

    test("a failed attempt releases the key so a genuine retry can succeed", async () => {
      // No app seeded — inspectForDeletion 404s on the first try.
      const d = deps();
      const key = "retry-after-failure-key";

      const first = await deleteAppWithIdempotency(d, "container-missing", key);
      assert.equal(first.success, false);
      assert.equal(first.statusCode, 404);

      // Now the container "appears" (simulates a slow-to-register app) and
      // the same key is retried.
      seedApp("late-app", "container-missing");
      const second = await deleteAppWithIdempotency(d, "container-missing", key);
      assert.equal(second.success, true);
    });

    test("a concurrent request with the same key is rejected as busy, not silently duplicated", async () => {
      seedApp("in-flight-app", "container-flight");
      let resolveRemove!: () => void;
      const gate = new Promise<void>((resolve) => { resolveRemove = resolve; });

      const { ops: baseOps } = createFakeOps(state);
      let removeCalls = 0;
      const slowOps: DeletionDockerOps = {
        ...baseOps,
        async removeContainer(id) {
          removeCalls += 1;
          await gate;
          return baseOps.removeContainer(id);
        }
      };

      const key = "in-flight-delete-key";
      const d = deps({ dockerOps: slowOps });

      const firstPromise = deleteAppWithIdempotency(d, "container-flight", key);
      await new Promise((resolve) => setImmediate(resolve));

      const second = await deleteAppWithIdempotency(d, "container-flight", key);
      assert.equal(second.success, false);
      assert.equal(second.statusCode, 409);
      assert.match(second.message, /already being processed/);

      resolveRemove();
      const first = await firstPromise;
      assert.equal(first.success, true);
      assert.equal(removeCalls, 1);
    });

    test("without a key, behavior is unchanged: a repeat delete of an already-deleted app is a plain 404", async () => {
      seedApp("no-key-app", "container-no-key");
      const d = deps();

      const first = await deleteAppWithIdempotency(d, "container-no-key");
      assert.equal(first.success, true);

      const second = await deleteAppWithIdempotency(d, "container-no-key");
      assert.equal(second.success, false);
      assert.equal(second.statusCode, 404);
    });
  });
});
