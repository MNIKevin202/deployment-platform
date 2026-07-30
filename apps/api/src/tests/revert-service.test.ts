import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { revertToDeployment, type RevertDockerOps } from "../services/revert-service.js";
import type { RedeployReconcileResult } from "../services/redeploy-service.js";
import type { RecordEventFn } from "../services/deployment-event-service.js";

const noopRecordEvent: RecordEventFn = () => {};

async function okReconcile(): Promise<RedeployReconcileResult> {
  return { lastReconcileSucceeded: true, lastError: null };
}

interface FakeOpsOptions {
  imageExistsResult?: boolean;
  startInspectRunning?: boolean;
}

function createFakeOps(options: FakeOpsOptions = {}): {
  ops: RevertDockerOps;
  calls: { pulled: string[]; createdImages: string[]; imageExistsQueried: string[] };
} {
  const calls = { pulled: [] as string[], createdImages: [] as string[], imageExistsQueried: [] as string[] };
  let nextId = 1;

  const ops: RevertDockerOps = {
    async imageExists(tag) {
      calls.imageExistsQueried.push(tag);
      return options.imageExistsResult ?? true;
    },
    async pullImage(image) {
      calls.pulled.push(image);
    },
    async createContainer(createOptions) {
      calls.createdImages.push((createOptions as { Image: string }).Image);
      return { id: `new-container-${nextId++}` };
    },
    async startContainer() {},
    async inspectContainer(id) {
      const running = options.startInspectRunning ?? true;
      return { id, running, status: running ? "running" : "created" };
    },
    async removeContainer() {},
    async renameContainer() {},
    async ensureVolume() {},
    async containerExists() {
      return true;
    },
    async stopContainer() {}
  };

  return { ops, calls };
}

describe("revertToDeployment", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-revert-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeGithubApp() {
    const app = appDatabase.createApp({
      name: "web",
      image: "deployment-app-1:bbbbbbbbbbbb",
      containerPort: 3000,
      containerName: "app-web"
    });

    // Two GitHub versions: v1 (older, revert target) and v2 (current).
    appDatabase.recordDeployment({
      appId: app.id,
      imageTag: "deployment-app-1:aaaaaaaaaaaa",
      commitSha: "aaaaaaaaaaaa1111",
      commitMessage: "first",
      sourceKind: "github"
    });
    appDatabase.recordDeployment({
      appId: app.id,
      imageTag: "deployment-app-1:bbbbbbbbbbbb",
      commitSha: "bbbbbbbbbbbb2222",
      commitMessage: "second",
      sourceKind: "github"
    });

    return app;
  }

  test("re-runs the target image and appends a new current version", async () => {
    const app = makeGithubApp();
    const { ops, calls } = createFakeOps();

    const result = await revertToDeployment(
      { appDatabase, dockerOps: ops, reconcileRouting: okReconcile, recordEvent: noopRecordEvent },
      app.id,
      1
    );

    assert.equal(result.success, true);
    assert.equal(result.newVersion, 3);

    // It confirmed the image was present, did NOT pull (local build), and
    // recreated the container from the target image.
    assert.deepEqual(calls.imageExistsQueried, ["deployment-app-1:aaaaaaaaaaaa"]);
    assert.equal(calls.pulled.length, 0);
    assert.ok(calls.createdImages.includes("deployment-app-1:aaaaaaaaaaaa"));

    // A new current version points at v1's image and records the revert.
    const current = appDatabase.getCurrentDeployment(app.id);
    assert.equal(current?.version, 3);
    assert.equal(current?.revertOfVersion, 1);
    assert.equal(current?.imageTag, "deployment-app-1:aaaaaaaaaaaa");

    // The app's stored image now matches the restored build.
    assert.equal(appDatabase.getAppById(app.id)?.image, "deployment-app-1:aaaaaaaaaaaa");
  });

  test("refuses to revert to the already-current version", async () => {
    const app = makeGithubApp();
    const { ops } = createFakeOps();

    const result = await revertToDeployment(
      { appDatabase, dockerOps: ops, reconcileRouting: okReconcile, recordEvent: noopRecordEvent },
      app.id,
      2
    );

    assert.equal(result.success, false);
    assert.match(result.message, /already the current/);
  });

  test("refuses to revert to a non-GitHub (image) version", async () => {
    const app = appDatabase.createApp({
      name: "db",
      image: "postgres:16-alpine",
      containerPort: 5432,
      containerName: "app-db"
    });
    appDatabase.recordDeployment({
      appId: app.id,
      imageTag: "postgres:15-alpine",
      commitSha: null,
      commitMessage: null,
      sourceKind: "image"
    });
    appDatabase.recordDeployment({
      appId: app.id,
      imageTag: "postgres:16-alpine",
      commitSha: null,
      commitMessage: null,
      sourceKind: "image"
    });

    const { ops } = createFakeOps();

    const result = await revertToDeployment(
      { appDatabase, dockerOps: ops, reconcileRouting: okReconcile, recordEvent: noopRecordEvent },
      app.id,
      1
    );

    assert.equal(result.success, false);
    assert.match(result.message, /Only GitHub-deployed versions/);
  });

  test("fails cleanly when the target image is no longer on the host", async () => {
    const app = makeGithubApp();
    const { ops } = createFakeOps({ imageExistsResult: false });

    const result = await revertToDeployment(
      { appDatabase, dockerOps: ops, reconcileRouting: okReconcile, recordEvent: noopRecordEvent },
      app.id,
      1
    );

    assert.equal(result.success, false);
    assert.match(result.message, /no longer available/);
    // No new version was appended.
    assert.equal(appDatabase.getCurrentDeployment(app.id)?.version, 2);
  });

  test("returns not found for an unknown version", async () => {
    const app = makeGithubApp();
    const { ops } = createFakeOps();

    const result = await revertToDeployment(
      { appDatabase, dockerOps: ops, reconcileRouting: okReconcile, recordEvent: noopRecordEvent },
      app.id,
      99
    );

    assert.equal(result.success, false);
    assert.match(result.message, /was not found/);
  });
});
