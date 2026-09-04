import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import {
  redeployApp,
  type ContainerInspectResult,
  type RedeployDockerOps,
  type RedeployReconcileResult
} from "../services/redeploy-service.js";
import type { RecordEventFn } from "../services/deployment-event-service.js";

const fakeRecordEvent: RecordEventFn = () => {};

interface FakeDockerOpsOptions {
  createContainerFails?: boolean;
  inspectRunning?: boolean;
  /** Fails removeContainer only when called with the canonical (old) name. */
  removeOldFails?: boolean;
  /** Fails removeContainer only when called with a "new-container-id-*" id. */
  removeNewCleanupFails?: boolean;
  renameFails?: boolean;
  /** Fails only the second inspectContainer call (the post-rename check). */
  finalInspectFails?: boolean;
  ensureVolumeFails?: boolean;
}

interface FakeDockerOpsCalls {
  pulledImages: string[];
  createContainerOptions: Array<Record<string, unknown>>;
  removedNames: string[];
  renamedTo: string[];
  inspectCallCount: number;
  ensuredVolumes: Array<{ name: string; ownerAppName: string }>;
}

function createFakeDockerOps(
  settings: FakeDockerOpsOptions = {}
): { ops: RedeployDockerOps; calls: FakeDockerOpsCalls } {
  const calls: FakeDockerOpsCalls = {
    pulledImages: [],
    createContainerOptions: [],
    removedNames: [],
    renamedTo: [],
    inspectCallCount: 0,
    ensuredVolumes: []
  };

  let nextContainerId = 1;

  const ops: RedeployDockerOps = {
    async pullImage(image) {
      calls.pulledImages.push(image);
    },

    async createContainer(createOptions) {
      calls.createContainerOptions.push(
        createOptions as Record<string, unknown>
      );

      if (settings.createContainerFails) {
        throw new Error("simulated createContainer failure");
      }

      const id = `new-container-id-${nextContainerId++}`;
      return { id };
    },

    async startContainer() {
      // No-op: nothing in these tests simulates a start-specific failure
      // that isn't already covered by inspectRunning.
    },

    async inspectContainer(id): Promise<ContainerInspectResult> {
      calls.inspectCallCount += 1;

      if (calls.inspectCallCount >= 2 && settings.finalInspectFails) {
        throw new Error("simulated final inspect failure");
      }

      const running = settings.inspectRunning ?? true;
      return { id, running, status: running ? "running" : "created" };
    },

    async removeContainer(nameOrId) {
      calls.removedNames.push(nameOrId);

      const isCanonicalName = !nameOrId.startsWith("new-container-id-");

      if (settings.removeOldFails && isCanonicalName) {
        throw new Error(`simulated remove failure for ${nameOrId}`);
      }

      if (settings.removeNewCleanupFails && !isCanonicalName) {
        throw new Error(`simulated cleanup failure for ${nameOrId}`);
      }
    },

    async renameContainer(id, newName) {
      calls.renamedTo.push(newName);

      if (settings.renameFails) {
        throw new Error(`simulated rename failure to ${newName}`);
      }
    },

    async refreshNetworkEndpoint() {},

    async ensureVolume(name, ownerAppName) {
      calls.ensuredVolumes.push({ name, ownerAppName });

      if (settings.ensureVolumeFails) {
        throw new Error(`simulated ensureVolume failure for ${name}`);
      }
    },

    async containerExists() {
      // redeployApp never calls this; present only to satisfy the interface.
      return true;
    },

    async stopContainer() {
      // redeployApp never calls this; present only to satisfy the interface.
    }
  };

  return { ops, calls };
}

async function fakeReconcile(): Promise<RedeployReconcileResult> {
  return { lastReconcileSucceeded: true, lastError: null };
}

describe("redeployApp", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-redeploy-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns not found for a nonexistent app", async () => {
    const { ops } = createFakeDockerOps();

    const result = await redeployApp(
      { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
      999999
    );

    assert.equal(result.success, false);
    assert.equal(result.message, "App not found");
  });

  test("refuses to redeploy a platform-owned container name", async () => {
    const app = appDatabase.createApp({
      name: "deployment-platform-api",
      image: "deployment-platform-api:0.6.0",
      containerPort: 3001,
      containerName: "deployment-platform-api"
    });

    const { ops, calls } = createFakeDockerOps();

    const result = await redeployApp(
      { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
      app.id
    );

    assert.equal(result.success, false);
    assert.match(result.message, /cannot be redeployed/);
    assert.equal(calls.pulledImages.length, 0);
  });

  test("succeeds: pulls image, creates under a temp name, swaps, updates DB, reconciles routing", async () => {
    const app = appDatabase.createApp({
      name: "sqlite-test",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-sqlite-test",
      domain: "sqlite-test.apps.hookstats.com"
    });

    appDatabase.createGlobalEnvVar({
      key: "TZ",
      value: "America/New_York",
      isSecret: false,
      enabled: true
    });

    appDatabase.createAppEnvVar({
      appId: app.id,
      key: "PORT",
      value: "8080",
      isSecret: false,
      enabled: true
    });

    const { ops, calls } = createFakeDockerOps();
    let reconcileCalled = false;

    const result = await redeployApp(
      {
        appDatabase,
        dockerOps: ops,
        reconcileRouting: async () => {
          reconcileCalled = true;
          return fakeReconcile();
        },
        recordEvent: fakeRecordEvent
      },
      app.id
    );

    assert.equal(result.success, true);
    assert.match(result.message, /redeployed successfully/i);
    assert.deepEqual(calls.pulledImages, ["nginx:alpine"]);
    assert.equal(reconcileCalled, true);

    // Created under a temporary name, not the canonical one.
    const createOptions = calls.createContainerOptions[0] as {
      name: string;
      Env: string[];
    };
    assert.match(createOptions.name, /^app-sqlite-test-redeploy-/);
    assert.ok(createOptions.Env.includes("TZ=America/New_York"));
    assert.ok(createOptions.Env.includes("PORT=8080"));

    // Old container removed by its canonical name, new one renamed into it.
    assert.ok(calls.removedNames.includes("app-sqlite-test"));
    assert.deepEqual(calls.renamedTo, ["app-sqlite-test"]);

    const updated = appDatabase.getAppById(app.id);
    assert.equal(updated?.containerId, "new-container-id-1");
    assert.equal(updated?.status, "running");
    assert.notEqual(updated?.lastDeployedAt, null);
  });

  test("cleans up and leaves the original container alone when the new one fails to start", async () => {
    const app = appDatabase.createApp({
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-one"
    });

    const before = appDatabase.getAppById(app.id);

    const { ops, calls } = createFakeDockerOps({ inspectRunning: false });

    const result = await redeployApp(
      { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
      app.id
    );

    assert.equal(result.success, false);
    assert.match(result.message, /not affected/);

    // The failed replacement was cleaned up by its container ID; the
    // original container's canonical name was never touched.
    assert.equal(calls.removedNames.length, 1);
    assert.equal(calls.removedNames[0], "new-container-id-1");
    assert.ok(!calls.removedNames.includes("app-app-one"));
    assert.deepEqual(calls.renamedTo, []);

    const after = appDatabase.getAppById(app.id);
    assert.deepEqual(after, before);
  });

  test("cleans up when createContainer itself throws", async () => {
    const app = appDatabase.createApp({
      name: "app-two",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-two"
    });

    const { ops, calls } = createFakeDockerOps({ createContainerFails: true });

    const result = await redeployApp(
      { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
      app.id
    );

    assert.equal(result.success, false);
    assert.match(result.message, /not affected/);

    // createContainer never returned an ID, so cleanup falls back to the
    // temporary name — a defensive no-op remove in case Docker partially
    // created the container despite the SDK call failing.
    assert.equal(calls.removedNames.length, 1);
    assert.match(calls.removedNames[0], /^app-app-two-redeploy-/);
  });

  describe("storage volumes", () => {
    test("ensures and mounts configured volumes on the replacement container", async () => {
      const app = appDatabase.createApp({
        name: "app-storage",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-storage"
      });

      appDatabase.createAppVolume({
        appId: app.id,
        volumeName: "app-storage-data",
        containerPath: "/data",
        readOnly: false
      });

      appDatabase.createAppVolume({
        appId: app.id,
        volumeName: "app-storage-config",
        containerPath: "/config",
        readOnly: true
      });

      const { ops, calls } = createFakeDockerOps();

      const result = await redeployApp(
        { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
        app.id
      );

      assert.equal(result.success, true);

      assert.deepEqual(
        calls.ensuredVolumes.map((v) => v.name).sort(),
        ["app-storage-config", "app-storage-data"]
      );
      assert.ok(
        calls.ensuredVolumes.every((v) => v.ownerAppName === "app-storage")
      );

      const createOptions = calls.createContainerOptions[0] as {
        HostConfig: {
          Mounts: Array<{
            Type: string;
            Source: string;
            Target: string;
            ReadOnly: boolean;
          }>;
        };
      };

      assert.deepEqual(
        [...createOptions.HostConfig.Mounts].sort((a, b) =>
          a.Source.localeCompare(b.Source)
        ),
        [
          {
            Type: "volume",
            Source: "app-storage-config",
            Target: "/config",
            ReadOnly: true
          },
          {
            Type: "volume",
            Source: "app-storage-data",
            Target: "/data",
            ReadOnly: false
          }
        ]
      );
    });

    test("a storage preparation failure aborts before touching the old container", async () => {
      const app = appDatabase.createApp({
        name: "app-storage-fail",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-storage-fail"
      });

      appDatabase.createAppVolume({
        appId: app.id,
        volumeName: "app-storage-fail-data",
        containerPath: "/data",
        readOnly: false
      });

      const before = appDatabase.getAppById(app.id);
      const { ops, calls } = createFakeDockerOps({ ensureVolumeFails: true });

      const result = await redeployApp(
        { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
        app.id
      );

      assert.equal(result.success, false);
      assert.match(result.message, /prepare storage/);
      assert.match(result.message, /not affected/);

      // Never got as far as creating a replacement or touching the old
      // container.
      assert.deepEqual(calls.createContainerOptions, []);
      assert.deepEqual(calls.removedNames, []);

      const after = appDatabase.getAppById(app.id);
      assert.deepEqual(after, before);
    });

    test("an app with no configured volumes gets an empty Mounts array, not an error", async () => {
      const app = appDatabase.createApp({
        name: "app-no-storage",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-no-storage"
      });

      const { ops, calls } = createFakeDockerOps();

      const result = await redeployApp(
        { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
        app.id
      );

      assert.equal(result.success, true);
      assert.deepEqual(calls.ensuredVolumes, []);

      const createOptions = calls.createContainerOptions[0] as {
        HostConfig: { Mounts: unknown[] };
      };
      assert.deepEqual(createOptions.HostConfig.Mounts, []);
    });
  });

  describe("failures after the replacement container is confirmed running", () => {
    test("old container removal fails, cleanup of the unused replacement succeeds, app is preserved", async () => {
      const app = appDatabase.createApp({
        name: "app-three",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-three"
      });

      const before = appDatabase.getAppById(app.id);
      const { ops, calls } = createFakeDockerOps({ removeOldFails: true });

      const result = await redeployApp(
        { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
        app.id
      );

      assert.equal(result.success, false);
      assert.match(result.message, /could not be removed/);
      assert.match(result.message, /left running/);
      assert.match(result.message, /cleaned up automatically/);
      assert.doesNotMatch(result.message, /remove it manually/);

      // Attempted removal of the old container, then cleanup of the new one.
      assert.deepEqual(calls.removedNames, [
        "app-app-three",
        "new-container-id-1"
      ]);
      assert.deepEqual(calls.renamedTo, []);

      const after = appDatabase.getAppById(app.id);
      assert.deepEqual(after, before);
    });

    test("old container removal fails, cleanup also fails: reports the leftover container ID without leaking config", async () => {
      const app = appDatabase.createApp({
        name: "app-three-b",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-three-b"
      });

      const before = appDatabase.getAppById(app.id);
      const { ops } = createFakeDockerOps({
        removeOldFails: true,
        removeNewCleanupFails: true
      });

      const result = await redeployApp(
        { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
        app.id
      );

      assert.equal(result.success, false);
      assert.match(result.message, /could not be removed/);
      assert.match(result.message, /remove it manually/);
      // The leftover container is identified by ID only.
      assert.match(result.message, /new-container-id-1/);
      // Nothing about image, env, or other config is included.
      assert.doesNotMatch(result.message, /nginx:alpine/);

      const after = appDatabase.getAppById(app.id);
      assert.deepEqual(after, before);
    });

    test("rename fails after the old container is already gone: DB left untouched, error names the leftover container", async () => {
      const app = appDatabase.createApp({
        name: "app-four",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-four"
      });

      const before = appDatabase.getAppById(app.id);
      const { ops } = createFakeDockerOps({ renameFails: true });

      const result = await redeployApp(
        { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
        app.id
      );

      assert.equal(result.success, false);
      assert.match(result.message, /could not.*be renamed/);
      assert.match(result.message, /new-container-id-1/);

      const after = appDatabase.getAppById(app.id);
      assert.deepEqual(after, before);
    });

    test("final inspect fails after a successful rename: DB updated with the new container ID and a fallback status, not left pointing at the deleted container", async () => {
      const app = appDatabase.createApp({
        name: "app-six",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-six"
      });

      const { ops } = createFakeDockerOps({ finalInspectFails: true });

      const result = await redeployApp(
        { appDatabase, dockerOps: ops, reconcileRouting: fakeReconcile, recordEvent: fakeRecordEvent },
        app.id
      );

      // The swap itself succeeded, so this is reported as success with a
      // warning, not a hard failure.
      assert.equal(result.success, true);
      assert.match(result.message, /redeployed successfully/i);
      assert.match(result.message, /status check failed/);
      assert.equal(result.containerId, "new-container-id-1");

      const updated = appDatabase.getAppById(app.id);
      // Must point at the new container, never the one that was removed.
      assert.equal(updated?.containerId, "new-container-id-1");
      // Falls back to the last known-good status (from the pre-swap check)
      // rather than leaving a stale or empty value.
      assert.equal(updated?.status, "running");
    });

    test("routing reconciliation throwing does not fail the redeploy or escape uncaught", async () => {
      const app = appDatabase.createApp({
        name: "app-seven",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-seven",
        domain: "app-seven.apps.hookstats.com"
      });

      const { ops } = createFakeDockerOps();

      const result = await redeployApp(
        {
          appDatabase,
          dockerOps: ops,
          reconcileRouting: async () => {
            throw new Error("simulated Caddy exec crash");
          },
          recordEvent: fakeRecordEvent
        },
        app.id
      );

      assert.equal(result.success, true);
      assert.match(result.message, /redeployed successfully/i);
      assert.match(result.message, /routing reconciliation failed/);
      assert.match(result.message, /simulated Caddy exec crash/);

      // The container swap and DB update still completed.
      const updated = appDatabase.getAppById(app.id);
      assert.equal(updated?.containerId, "new-container-id-1");
    });

    test("routing reconciliation returning a failure is still reported as a warning", async () => {
      const app = appDatabase.createApp({
        name: "app-five",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-five",
        domain: "app-five.apps.hookstats.com"
      });

      const { ops } = createFakeDockerOps();

      const result = await redeployApp(
        {
          appDatabase,
          dockerOps: ops,
          reconcileRouting: async () => ({
            lastReconcileSucceeded: false,
            lastError: "Caddy reload failed"
          }),
          recordEvent: fakeRecordEvent
        },
        app.id
      );

      assert.equal(result.success, true);
      assert.match(result.message, /routing could not be updated/);

      const updated = appDatabase.getAppById(app.id);
      assert.notEqual(updated?.containerId, null);
    });

    test("a database write failure after a successful swap is reported precisely, not as success", async () => {
      const app = appDatabase.createApp({
        name: "app-eight",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-app-eight"
      });

      const { ops } = createFakeDockerOps();

      // Same underlying database, but with updateAppContainer replaced to
      // simulate a write failure after Docker has already been swapped.
      const throwingAppDatabase: AppDatabase = {
        ...appDatabase,
        updateAppContainer: () => {
          throw new Error("simulated database write failure");
        }
      };

      const result = await redeployApp(
        {
          appDatabase: throwingAppDatabase,
          dockerOps: ops,
          reconcileRouting: fakeReconcile,
          recordEvent: fakeRecordEvent
        },
        app.id
      );

      assert.equal(result.success, false);
      assert.match(result.message, /database could not be updated/);
      assert.match(result.message, /new-container-id-1/);
      assert.equal(result.containerId, "new-container-id-1");

      // The real database was never actually written by the failing call,
      // so it still reflects the pre-redeploy state.
      const stillOld = appDatabase.getAppById(app.id);
      assert.equal(stillOld?.containerId, null);
    });
  });
});
