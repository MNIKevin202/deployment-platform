import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { deployFromGithub, type GithubDeployDependencies } from "../services/github-deploy-service.js";
import type { SourceProviderClient } from "../services/source-provider.js";
import type { RecordEventFn } from "../services/deployment-event-service.js";

function unusedGithubClient(): SourceProviderClient {
  const fail = () => {
    throw new Error("unexpectedly called in this test");
  };
  return {
    provider: "github",
    validateCredential: fail,
    listRepositories: fail,
    getRepository: fail,
    listBranches: fail,
    listCommits: fail,
    resolveBranchCommit: fail,
    pathExists: fail,
    getFileContents: fail
  };
}

function unusedDockerOps(): GithubDeployDependencies["dockerOps"] {
  const fail = () => {
    throw new Error("unexpectedly called in this test");
  };
  return {
    pullImage: fail,
    createContainer: fail,
    startContainer: fail,
    inspectContainer: fail,
    removeContainer: fail,
    renameContainer: fail,
    ensureVolume: fail,
    buildImage: fail,
    imageExists: fail
  };
}

describe("deployFromGithub — guard clauses (no clone/build reached)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let recordedEvents: Array<{ eventType: string; message: string; metadata?: Record<string, unknown> }>;
  let recordEvent: RecordEventFn;
  let baseDeps: GithubDeployDependencies;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "github-deploy-service-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
    recordedEvents = [];
    recordEvent = (input) => {
      recordedEvents.push({ eventType: input.eventType, message: input.message, metadata: input.metadata });
    };

    baseDeps = {
      appDatabase,
      dockerOps: unusedDockerOps(),
      githubClient: unusedGithubClient(),
      resolveCredential: async () => ({ success: false, credentialStatus: "not-configured" }),
      reconcileRouting: async () => ({ lastReconcileSucceeded: true, lastError: null }),
      recordEvent
    };
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeApp(name: string) {
    return appDatabase.createApp({
      name,
      image: "nginx:alpine",
      containerPort: 80,
      containerName: `app-${name}`
    });
  }

  test("returns a clear failure when the app does not exist", async () => {
    const result = await deployFromGithub(baseDeps, 999999);
    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.match(result.message, /not found/i);
  });

  test("returns a clear failure when no GitHub source is configured", async () => {
    const app = makeApp("no-source");
    const result = await deployFromGithub(baseDeps, app.id);
    assert.equal(result.success, false);
    assert.match(result.message, /no github source/i);
  });

  test("never leaves the deployment lock held after a pre-clone failure", async () => {
    const app = makeApp("credential-missing");
    appDatabase.upsertAppSource(app.id, {
      provider: "github",
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      repositoryFullName: "octocat/hello-world",
      repositoryCloneUrl: "https://github.com/octocat/hello-world.git",
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      subdirectory: ".",
      deploymentMode: "dockerfile",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      containerPort: null,
      autoDeploy: false
    });

    const result = await deployFromGithub(baseDeps, app.id);

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.match(result.message, /not connected/i);
    assert.equal(appDatabase.isDeploymentLocked(app.id), false);

    const failedEvent = recordedEvents.find((e) => e.eventType === "github-deploy-failed");
    assert.ok(failedEvent, "a github-deploy-failed event should have been recorded");
  });

  test("refuses a second concurrent deployment for the same app", async () => {
    const app = makeApp("already-deploying");
    appDatabase.upsertAppSource(app.id, {
      provider: "github",
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      repositoryFullName: "octocat/hello-world",
      repositoryCloneUrl: "https://github.com/octocat/hello-world.git",
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      subdirectory: ".",
      deploymentMode: "dockerfile",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      containerPort: null,
      autoDeploy: false
    });

    // Simulate an in-progress deployment held by someone else.
    assert.equal(appDatabase.acquireDeploymentLock(app.id), true);

    const result = await deployFromGithub(baseDeps, app.id);

    assert.equal(result.success, false);
    assert.match(result.message, /already in progress/i);
    // The lock we (the test) hold must not have been touched by the
    // rejected attempt.
    assert.equal(appDatabase.isDeploymentLocked(app.id), true);
  });

  test("records safe, structured clone-failure diagnostics on the deployment event, not a vague message", async () => {
    const app = makeApp("clone-fails");
    appDatabase.upsertAppSource(app.id, {
      provider: "github",
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      repositoryFullName: "octocat/hello-world",
      repositoryCloneUrl: "https://github.com/octocat/hello-world.git",
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      subdirectory: ".",
      deploymentMode: "dockerfile",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      containerPort: null,
      autoDeploy: false
    });

    const githubClient: SourceProviderClient = {
      ...unusedGithubClient(),
      resolveBranchCommit: async () => "a".repeat(40),
      listCommits: async () => ({ items: [], hasMore: false })
    };

    const deps: GithubDeployDependencies = {
      ...baseDeps,
      githubClient,
      resolveCredential: async () => ({ success: true, token: "fake_token_for_tests_only", source: "pat" }),
      // A guaranteed-nonexistent absolute path deterministically forces
      // ENOENT on every platform — unlike clearing PATH, which does not
      // reliably work (macOS in particular falls back to a default
      // system PATH containing a real `git` when the child's own PATH
      // is empty). This exercises the real clone code path (spawn ->
      // ENOENT -> CloneError -> GithubDeployError -> event metadata)
      // without a real repository, token, or network call.
      gitExecutable: "/definitely-not-present/deployment-platform-test-git"
    };

    const result = await deployFromGithub(deps, app.id);

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.equal(result.message, "Git executable was not found");
    assert.doesNotMatch(result.message, /exit code unknown/i);

    const failedEvent = recordedEvents.find((e) => e.eventType === "github-deploy-failed");
    assert.ok(failedEvent, "a github-deploy-failed event should have been recorded");
    assert.equal(failedEvent?.metadata?.stage, "cloning-repository");
    assert.equal(failedEvent?.metadata?.processStarted, false);
    assert.equal(failedEvent?.metadata?.spawnErrorCode, "ENOENT");

    const metadataJson = JSON.stringify(failedEvent?.metadata ?? {});
    assert.ok(!metadataJson.includes("fake_token_for_tests_only"));
    assert.ok(!/\/tmp\//.test(metadataJson));
  });
});
