import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("build-log + auto-deploy database methods", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-settings-db-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeApp(name: string) {
    return appDatabase.createApp({ name, image: "nginx:alpine", containerPort: 80, containerName: `app-${name}` });
  }

  function linkSource(appId: number, overrides: Record<string, unknown> = {}) {
    return appDatabase.upsertAppSource(appId, {
      provider: "github",
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      repositoryFullName: "octocat/hello-world",
      repositoryCloneUrl: "https://github.com/octocat/hello-world.git",
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      subdirectory: ".",
      deploymentMode: "dockerfile" as const,
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      containerPort: null,
      autoDeploy: false,
      ...overrides
    });
  }

  test("getBuildLog is null with no source, and round-trips after updateBuildLog", () => {
    const app = makeApp("blog");
    assert.equal(appDatabase.getBuildLog(app.id), null);

    linkSource(app.id);
    assert.deepEqual(appDatabase.getBuildLog(app.id), {
      log: null,
      truncated: false,
      status: null,
      at: null,
      commitSha: null,
      autoDeployBlocked: false
    });

    appDatabase.updateBuildLog(app.id, {
      log: "Step 1/3 : FROM node\n...done",
      truncated: true,
      status: "success",
      at: "2026-07-30T12:00:00.000Z",
      commitSha: "deadbeef1234"
    });

    assert.deepEqual(appDatabase.getBuildLog(app.id), {
      log: "Step 1/3 : FROM node\n...done",
      truncated: true,
      status: "success",
      at: "2026-07-30T12:00:00.000Z",
      commitSha: "deadbeef1234",
      autoDeployBlocked: false
    });
  });

  test("setAutoDeployBlockedCommit blocks a commit, reflects it, and lists it on the candidate", () => {
    const app = makeApp("block");
    // No source yet — nothing to block.
    assert.equal(appDatabase.setAutoDeployBlockedCommit(app.id, "bad-sha"), false);

    linkSource(app.id, { autoDeploy: true });
    appDatabase.updateBuildLog(app.id, {
      log: "boom",
      truncated: false,
      status: "failed",
      at: "2026-07-30T12:00:00.000Z",
      commitSha: "bad-sha"
    });

    // Not blocked yet.
    assert.equal(appDatabase.getBuildLog(app.id)?.autoDeployBlocked, false);

    // Block that exact commit → reflected on the build log and the candidate.
    assert.equal(appDatabase.setAutoDeployBlockedCommit(app.id, "bad-sha"), true);
    assert.equal(appDatabase.getBuildLog(app.id)?.autoDeployBlocked, true);
    assert.equal(appDatabase.listAutoDeploySources()[0].autoDeployBlockedCommit, "bad-sha");

    // Clearing it removes the block.
    assert.equal(appDatabase.setAutoDeployBlockedCommit(app.id, null), true);
    assert.equal(appDatabase.getBuildLog(app.id)?.autoDeployBlocked, false);
    assert.equal(appDatabase.listAutoDeploySources()[0].autoDeployBlockedCommit, null);
  });

  test("setAutoDeploy toggles the flag and reports whether a source existed", () => {
    const app = makeApp("ad");
    // No source yet — nothing to toggle.
    assert.equal(appDatabase.setAutoDeploy(app.id, true), false);

    linkSource(app.id);
    assert.equal(appDatabase.setAutoDeploy(app.id, true), true);
    assert.equal(appDatabase.getAppSource(app.id)?.autoDeploy, true);

    // Turning it back off still updates a row that exists, so this is true.
    assert.equal(appDatabase.setAutoDeploy(app.id, false), true);
    assert.equal(appDatabase.getAppSource(app.id)?.autoDeploy, false);
  });

  test("listAutoDeploySources returns only enabled sources with their deploy state", () => {
    const enabled = makeApp("on");
    const disabled = makeApp("off");
    linkSource(enabled.id, { autoDeploy: true });
    linkSource(disabled.id, { autoDeploy: false });

    // Record a deployed commit so the candidate carries it (what the poller diffs against).
    appDatabase.updateDeployedCommit(enabled.id, {
      commitSha: "abc123",
      commitMessage: "msg",
      deployedAt: "2026-07-30T12:00:00.000Z"
    });

    const candidates = appDatabase.listAutoDeploySources();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].appId, enabled.id);
    assert.equal(candidates[0].repositoryOwner, "octocat");
    assert.equal(candidates[0].repositoryName, "hello-world");
    assert.equal(candidates[0].branch, "main");
    assert.equal(candidates[0].latestDeployedCommitSha, "abc123");
  });
});
