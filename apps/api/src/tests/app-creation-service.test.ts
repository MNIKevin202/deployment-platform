import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import {
  createAppWithConfig,
  type CreateAppServiceDependencies
} from "../services/app-creation-service.js";
import type { RedeployDockerOps } from "../services/redeploy-service.js";

interface FakeOpsSettings {
  pullFails?: boolean;
  ensureVolumeFails?: boolean;
  createContainerFails?: boolean;
  startFails?: boolean;
  inspectFails?: boolean;
  inspectRunning?: boolean;
  removeContainerFails?: boolean;
}

interface FakeOpsCalls {
  pulledImages: string[];
  ensuredVolumes: Array<{ name: string; ownerAppName: string }>;
  createContainerOptions: Array<Record<string, unknown>>;
  removedContainerIds: string[];
  /** Records every operation in call order, for asserting sequencing precisely. */
  operationLog: string[];
}

function createFakeOps(
  settings: FakeOpsSettings = {}
): { ops: RedeployDockerOps; calls: FakeOpsCalls } {
  const calls: FakeOpsCalls = {
    pulledImages: [],
    ensuredVolumes: [],
    createContainerOptions: [],
    removedContainerIds: [],
    operationLog: []
  };

  let nextId = 1;

  const ops: RedeployDockerOps = {
    async pullImage(image) {
      calls.operationLog.push("pullImage");
      calls.pulledImages.push(image);

      if (settings.pullFails) {
        throw new Error("simulated pull failure");
      }
    },

    async ensureVolume(name, ownerAppName) {
      calls.operationLog.push("ensureVolume");
      calls.ensuredVolumes.push({ name, ownerAppName });

      if (settings.ensureVolumeFails) {
        throw new Error(
          `Docker volume "${name}" already exists and is not owned by this app`
        );
      }
    },

    async createContainer(options) {
      calls.operationLog.push("createContainer");
      calls.createContainerOptions.push(options as Record<string, unknown>);

      if (settings.createContainerFails) {
        throw new Error("simulated createContainer failure");
      }

      return { id: `container-id-${nextId++}` };
    },

    async startContainer(id) {
      calls.operationLog.push(`startContainer:${id}`);

      if (settings.startFails) {
        throw new Error("simulated start failure");
      }
    },

    async inspectContainer(id) {
      calls.operationLog.push(`inspectContainer:${id}`);

      if (settings.inspectFails) {
        throw new Error("simulated inspect failure");
      }

      const running = settings.inspectRunning ?? true;
      return { id, running, status: running ? "running" : "created" };
    },

    async removeContainer(nameOrId) {
      calls.operationLog.push(`removeContainer:${nameOrId}`);
      calls.removedContainerIds.push(nameOrId);

      if (settings.removeContainerFails) {
        throw new Error("simulated removeContainer failure");
      }
    },

    async renameContainer() {}
  };

  return { ops, calls };
}

async function fakeReconcileSuccess() {
  return { lastReconcileSucceeded: true, lastError: null };
}

function fakeIsRoutingReady(hasDomain: boolean): boolean {
  return hasDomain;
}

/** Wraps updateAppContainer so it throws — used to simulate a database
 * metadata write failure after Docker creation already succeeded. */
function withThrowingUpdateAppContainer(appDatabase: AppDatabase): AppDatabase {
  return {
    ...appDatabase,
    updateAppContainer: () => {
      throw new Error("simulated updateAppContainer failure");
    }
  };
}

/** Wraps deleteApp so it throws without actually deleting the row — used to
 * simulate cleanup itself failing, so the row genuinely stays behind. */
function withThrowingDeleteApp(appDatabase: AppDatabase): AppDatabase {
  return {
    ...appDatabase,
    deleteApp: () => {
      throw new Error("simulated deleteApp failure");
    }
  };
}

/** Tracks how many times reconcileRouting was invoked, delegating to a
 * caller-supplied result so both call count and outcome can be asserted. */
function createReconcileTracker(
  result: { lastReconcileSucceeded: boolean | null; lastError: string | null } = {
    lastReconcileSucceeded: true,
    lastError: null
  }
) {
  let callCount = 0;

  return {
    reconcileRouting: async () => {
      callCount += 1;
      return result;
    },
    getCallCount: () => callCount
  };
}

describe("createAppWithConfig", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-create-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function deps(
    overrides: Partial<CreateAppServiceDependencies> = {}
  ): CreateAppServiceDependencies {
    return {
      appDatabase,
      dockerOps: createFakeOps().ops,
      buildDomain: (name) => `${name}.apps.hookstats.com`,
      reconcileRouting: fakeReconcileSuccess,
      isRoutingReady: fakeIsRoutingReady,
      ...overrides
    };
  }

  test("rejects a duplicate app name before touching Docker", async () => {
    appDatabase.createApp({
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-one"
    });

    const { ops, calls } = createFakeOps();

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 409);
    assert.match(result.message, /already exists/);
    assert.equal(calls.pulledImages.length, 0);
  });

  test("rejects a duplicate domain before touching Docker", async () => {
    appDatabase.createApp({
      name: "existing",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-existing",
      domain: "new-app.apps.hookstats.com"
    });

    const { ops } = createFakeOps();

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "new-app",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 409);
    assert.match(result.message, /already assigned/);
  });

  test("succeeds with no environment variables or storage mounts", async () => {
    const { ops, calls } = createFakeOps();

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "bare-app",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, true);
    assert.equal(result.app?.environmentVariableCount, 0);
    assert.equal(result.app?.secretVariableCount, 0);
    assert.equal(result.app?.storageMountCount, 0);

    const createOptions = calls.createContainerOptions[0] as {
      HostConfig: { Mounts: unknown[] };
      Env: string[];
    };
    assert.deepEqual(createOptions.HostConfig.Mounts, []);
    assert.deepEqual(createOptions.Env, []);
  });

  test("succeeds with environment variables and storage mounts, coordinated in one transaction", async () => {
    appDatabase.createGlobalEnvVar({
      key: "TZ",
      value: "America/New_York",
      isSecret: false,
      enabled: true
    });

    const { ops, calls } = createFakeOps();

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "full-app",
      image: "nginx:alpine",
      containerPort: 80,
      environmentVariables: [
        { key: "API_URL", value: "https://example.com", isSecret: false, enabled: true },
        { key: "DB_PASSWORD", value: "hunter2", isSecret: true, enabled: true }
      ],
      storageMounts: [
        { containerPath: "/data", readOnly: false },
        { containerPath: "/config", volumeName: "full-app-cfg", readOnly: true }
      ]
    });

    assert.equal(result.success, true);
    assert.equal(result.app?.environmentVariableCount, 2);
    assert.equal(result.app?.secretVariableCount, 1);
    assert.equal(result.app?.storageMountCount, 2);

    const app = appDatabase.getAppByName("full-app");
    assert.ok(app);
    assert.equal(appDatabase.listAppEnvVars(app!.id).length, 2);
    assert.equal(appDatabase.listAppVolumes(app!.id).length, 2);

    const createOptions = calls.createContainerOptions[0] as {
      Env: string[];
      HostConfig: {
        Mounts: Array<{ Source: string; Target: string; ReadOnly: boolean }>;
      };
    };

    assert.ok(createOptions.Env.includes("TZ=America/New_York"));
    assert.ok(createOptions.Env.includes("API_URL=https://example.com"));
    assert.ok(createOptions.Env.includes("DB_PASSWORD=hunter2"));

    const mountTargets = createOptions.HostConfig.Mounts.map((m) => m.Target).sort();
    assert.deepEqual(mountTargets, ["/config", "/data"]);

    const configMount = createOptions.HostConfig.Mounts.find(
      (m) => m.Target === "/config"
    );
    assert.equal(configMount?.Source, "full-app-cfg");
    assert.equal(configMount?.ReadOnly, true);

    assert.ok(
      calls.ensuredVolumes.some((v) => v.name === "full-app-cfg" && v.ownerAppName === "full-app")
    );
  });

  test("auto-generates a volume name when none is provided", async () => {
    const { ops } = createFakeOps();

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "auto-vol-app",
      image: "nginx:alpine",
      containerPort: 80,
      storageMounts: [{ containerPath: "/data", readOnly: false }]
    });

    assert.equal(result.success, true);
    const app = appDatabase.getAppByName("auto-vol-app");
    const volumes = appDatabase.listAppVolumes(app!.id);
    assert.equal(volumes.length, 1);
    assert.equal(volumes[0].volumeName, "auto-vol-app-data");
  });

  test("rejects a reserved volume name without creating anything", async () => {
    const { ops, calls } = createFakeOps();

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "reserved-test",
      image: "nginx:alpine",
      containerPort: 80,
      storageMounts: [
        { containerPath: "/data", volumeName: "deployment-platform-api-data", readOnly: false }
      ]
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 400);
    assert.match(result.message, /reserved/);
    assert.equal(appDatabase.getAppByName("reserved-test"), null);
    assert.equal(calls.pulledImages.length, 0);
  });

  test("rolls back the entire transaction — app, env vars, and volumes — when a later DB insert fails", async () => {
    let envVarInsertCount = 0;

    const throwingAppDatabase: AppDatabase = {
      ...appDatabase,
      createAppEnvVar: (input) => {
        envVarInsertCount += 1;

        if (envVarInsertCount === 2) {
          throw new Error("simulated second insert failure");
        }

        return appDatabase.createAppEnvVar(input);
      }
    };

    const { ops } = createFakeOps();

    const result = await createAppWithConfig(
      deps({ appDatabase: throwingAppDatabase, dockerOps: ops }),
      {
        name: "rollback-app",
        image: "nginx:alpine",
        containerPort: 80,
        environmentVariables: [
          { key: "FIRST", value: "1", isSecret: false, enabled: true },
          { key: "SECOND", value: "2", isSecret: false, enabled: true }
        ]
      }
    );

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 500);
    assert.match(result.message, /Unable to save app configuration/);

    // Nothing was left behind — not the app row, not the first env var
    // insert that happened before the failure, all rolled back together.
    assert.equal(appDatabase.getAppByName("rollback-app"), null);
  });

  test("rolls back at the database level when duplicate environment keys are submitted directly (defense in depth beneath the schema layer)", async () => {
    const { ops } = createFakeOps();

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "dup-env-app",
      image: "nginx:alpine",
      containerPort: 80,
      environmentVariables: [
        { key: "SAME_KEY", value: "1", isSecret: false, enabled: true },
        { key: "SAME_KEY", value: "2", isSecret: false, enabled: true }
      ]
    });

    assert.equal(result.success, false);
    assert.equal(appDatabase.getAppByName("dup-env-app"), null);
  });

  test("cleans up the app record (not the named volumes) when Docker image pull fails", async () => {
    const { ops } = createFakeOps({ pullFails: true });

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "pull-fail-app",
      image: "nginx:alpine",
      containerPort: 80,
      storageMounts: [{ containerPath: "/data", readOnly: false }]
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 502);
    assert.match(result.message, /Unable to create the app container/);
    assert.equal(appDatabase.getAppByName("pull-fail-app"), null);
  });

  test("cleans up the app record when createContainer fails", async () => {
    const { ops } = createFakeOps({ createContainerFails: true });

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "create-fail-app",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 502);
    assert.equal(appDatabase.getAppByName("create-fail-app"), null);
  });

  test("cleans up the app record on a volume ownership conflict, without deleting any volume", async () => {
    const { ops, calls } = createFakeOps({ ensureVolumeFails: true });

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "conflict-app",
      image: "nginx:alpine",
      containerPort: 80,
      storageMounts: [{ containerPath: "/data", readOnly: false }]
    });

    assert.equal(result.success, false);
    assert.match(result.message, /not owned by this app/);
    assert.equal(appDatabase.getAppByName("conflict-app"), null);
    // The fake never exposes a "remove volume" call at all — this service
    // has no code path that could invoke one.
    assert.equal(calls.ensuredVolumes.length, 1);
  });

  test("reports a routing warning without failing the creation", async () => {
    const { ops } = createFakeOps();

    const result = await createAppWithConfig(
      deps({
        dockerOps: ops,
        reconcileRouting: async () => ({
          lastReconcileSucceeded: false,
          lastError: "Caddy reload failed"
        })
      }),
      {
        name: "routing-warn-app",
        image: "nginx:alpine",
        containerPort: 80
      }
    );

    assert.equal(result.success, true);
    assert.match(result.message, /routing could not be updated/);
    assert.ok(appDatabase.getAppByName("routing-warn-app"));
  });

  test("removes the created container and rolls back the app record when startContainer fails", async () => {
    const { ops, calls } = createFakeOps({ startFails: true });

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "start-fail-app",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 502);
    assert.match(result.message, /simulated start failure/);

    assert.deepEqual(calls.removedContainerIds, ["container-id-1"]);
    assert.equal(result.cleanup?.containerRemoved, true);
    assert.equal(result.cleanup?.leftoverContainerId, null);
    assert.equal(result.cleanup?.appRecordRemoved, true);
    assert.equal(result.cleanup?.staleAppRecord, false);

    assert.equal(appDatabase.getAppByName("start-fail-app"), null);
  });

  test("removes the created container and rolls back the app record when inspectContainer throws", async () => {
    const { ops, calls } = createFakeOps({ inspectFails: true });

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "inspect-fail-app",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, false);
    assert.match(result.message, /simulated inspect failure/);

    assert.deepEqual(calls.removedContainerIds, ["container-id-1"]);
    assert.equal(result.cleanup?.containerRemoved, true);
    assert.equal(result.cleanup?.appRecordRemoved, true);

    assert.equal(appDatabase.getAppByName("inspect-fail-app"), null);
  });

  test("treats a container that never reaches running as a failure and cleans up", async () => {
    const { ops, calls } = createFakeOps({ inspectRunning: false });

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "not-running-app",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, false);
    assert.match(result.message, /failed to reach a running state/);
    assert.match(result.message, /status: created/);

    assert.deepEqual(calls.removedContainerIds, ["container-id-1"]);
    assert.equal(result.cleanup?.containerRemoved, true);
    assert.equal(result.cleanup?.appRecordRemoved, true);

    assert.equal(appDatabase.getAppByName("not-running-app"), null);
  });

  test("does not attempt routing reconciliation when the container never reaches running", async () => {
    const { ops } = createFakeOps({ inspectRunning: false });
    const tracker = createReconcileTracker();

    await createAppWithConfig(
      deps({ dockerOps: ops, reconcileRouting: tracker.reconcileRouting }),
      {
        name: "no-routing-app",
        image: "nginx:alpine",
        containerPort: 80
      }
    );

    assert.equal(tracker.getCallCount(), 0);
  });

  test("removes the created container and rolls back the app record when updateAppContainer fails", async () => {
    const { ops, calls } = createFakeOps();
    const throwingAppDatabase = withThrowingUpdateAppContainer(appDatabase);

    const result = await createAppWithConfig(
      deps({ appDatabase: throwingAppDatabase, dockerOps: ops }),
      {
        name: "update-fail-app",
        image: "nginx:alpine",
        containerPort: 80
      }
    );

    assert.equal(result.success, false);
    assert.match(result.message, /simulated updateAppContainer failure/);

    assert.deepEqual(calls.removedContainerIds, ["container-id-1"]);
    assert.equal(result.cleanup?.containerRemoved, true);
    assert.equal(result.cleanup?.appRecordRemoved, true);

    // The real (unwrapped) database is what the fake delegates non-throwing
    // calls to, so the rollback is visible through it too.
    assert.equal(appDatabase.getAppByName("update-fail-app"), null);
  });

  test("reports the leftover container id when container removal itself fails", async () => {
    const { ops, calls } = createFakeOps({
      startFails: true,
      removeContainerFails: true
    });

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "remove-fail-app",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, false);
    // The original failure is still the leading part of the message.
    assert.match(result.message, /^Unable to create the app container: simulated start failure/);
    assert.match(result.message, /needs manual cleanup/);
    assert.match(result.message, /container-id-1/);

    assert.deepEqual(calls.removedContainerIds, ["container-id-1"]);
    assert.equal(result.cleanup?.containerRemoved, false);
    assert.equal(result.cleanup?.leftoverContainerId, "container-id-1");

    // Database cleanup is independent of container cleanup and still
    // succeeds here.
    assert.equal(result.cleanup?.appRecordRemoved, true);
    assert.equal(appDatabase.getAppByName("remove-fail-app"), null);
  });

  test("reports a stale app record without masking the original creation error when database cleanup fails", async () => {
    const { ops } = createFakeOps({ startFails: true });
    const throwingAppDatabase = withThrowingDeleteApp(appDatabase);

    const result = await createAppWithConfig(
      deps({ appDatabase: throwingAppDatabase, dockerOps: ops }),
      {
        name: "stale-record-app",
        image: "nginx:alpine",
        containerPort: 80
      }
    );

    assert.equal(result.success, false);
    // The original Docker failure still leads the message.
    assert.match(result.message, /^Unable to create the app container: simulated start failure/);
    assert.match(result.message, /may need manual repair/);

    assert.equal(result.cleanup?.containerRemoved, true);
    assert.equal(result.cleanup?.appRecordRemoved, false);
    assert.equal(result.cleanup?.staleAppRecord, true);

    // deleteApp's override threw before touching the row, so it's really
    // still there — the "stale record" report reflects real state.
    assert.ok(appDatabase.getAppByName("stale-record-app"));
  });

  test("reports both cleanup failures explicitly when container and database cleanup both fail", async () => {
    const { ops, calls } = createFakeOps({
      startFails: true,
      removeContainerFails: true
    });
    const throwingAppDatabase = withThrowingDeleteApp(appDatabase);

    const result = await createAppWithConfig(
      deps({ appDatabase: throwingAppDatabase, dockerOps: ops }),
      {
        name: "double-fail-app",
        image: "nginx:alpine",
        containerPort: 80
      }
    );

    assert.equal(result.success, false);
    assert.match(result.message, /^Unable to create the app container: simulated start failure/);
    assert.match(result.message, /needs manual cleanup/);
    assert.match(result.message, /may need manual repair/);

    assert.equal(result.cleanup?.containerRemoved, false);
    assert.equal(result.cleanup?.leftoverContainerId, "container-id-1");
    assert.equal(result.cleanup?.appRecordRemoved, false);
    assert.equal(result.cleanup?.staleAppRecord, true);

    assert.deepEqual(calls.removedContainerIds, ["container-id-1"]);
    assert.ok(appDatabase.getAppByName("double-fail-app"));
  });

  test("returns success with a routing warning when reconcileRouting throws, without deleting the app", async () => {
    const { ops } = createFakeOps();

    const result = await createAppWithConfig(
      deps({
        dockerOps: ops,
        reconcileRouting: async () => {
          throw new Error("Caddy reload crashed");
        }
      }),
      {
        name: "routing-throws-app",
        image: "nginx:alpine",
        containerPort: 80
      }
    );

    assert.equal(result.success, true);
    assert.match(result.message, /routing reconciliation failed: Caddy reload crashed/);
    assert.ok(appDatabase.getAppByName("routing-throws-app"));
  });

  test("never includes a secret environment variable value in a failure message", async () => {
    const { ops } = createFakeOps({ startFails: true });
    const secretValue = "super-secret-token-xyz-123";

    const result = await createAppWithConfig(deps({ dockerOps: ops }), {
      name: "secret-safe-app",
      image: "nginx:alpine",
      containerPort: 80,
      environmentVariables: [
        { key: "API_TOKEN", value: secretValue, isSecret: true, enabled: true }
      ]
    });

    assert.equal(result.success, false);
    assert.ok(!result.message.includes(secretValue));
    assert.ok(!JSON.stringify(result.cleanup ?? {}).includes(secretValue));
  });
});
