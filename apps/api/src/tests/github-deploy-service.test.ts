import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  test("passes a GitHub App installation-sourced credential straight through to the real clone process (regression: 'Stored GitHub token has an unexpected shape')", async () => {
    const app = makeApp("installation-credential");
    // The exact roadmapstudio-web fixture shape: repository, subdirectory,
    // Dockerfile path, and build context all matching the real app.
    appDatabase.upsertAppSource(app.id, {
      provider: "github",
      repositoryOwner: "MNIKevin202",
      repositoryName: "DeploymentPlatformInstaller",
      repositoryFullName: "MNIKevin202/DeploymentPlatformInstaller",
      repositoryCloneUrl: "https://github.com/MNIKevin202/DeploymentPlatformInstaller.git",
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      subdirectory: "tools/roadmap-studio",
      deploymentMode: "dockerfile",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      containerPort: 4319,
      autoDeploy: false
    });

    const githubClient: SourceProviderClient = {
      ...unusedGithubClient(),
      resolveBranchCommit: async () => "b".repeat(40),
      listCommits: async () => ({ items: [], hasMore: false })
    };

    // A fresh, never-persisted installation token shape — resolveGithubToken's
    // installation branch never validates this against the PAT-only
    // githubTokenSchema, so it may contain characters that schema would
    // reject (here: hyphens, a period, a tilde).
    const installationToken = "ghs_fake-installation.token~for-tests-only";

    const deps: GithubDeployDependencies = {
      ...baseDeps,
      githubClient,
      resolveCredential: async () => ({ success: true, token: installationToken, source: "installation" }),
      gitExecutable: "/definitely-not-present/deployment-platform-test-git"
    };

    const result = await deployFromGithub(deps, app.id);

    assert.equal(result.success, false);
    // Reached the real clone process (ENOENT from the nonexistent git
    // binary) — NOT rejected earlier by a token-shape check. If the old
    // "Stored GitHub token has an unexpected shape" bug were still
    // present, this would fail at "preparing-checkout" with that message
    // instead.
    assert.equal(result.message, "Git executable was not found");
    assert.notEqual(result.message, "Stored GitHub token has an unexpected shape");

    const failedEvent = recordedEvents.find((e) => e.eventType === "github-deploy-failed");
    assert.ok(failedEvent);
    assert.equal(failedEvent?.metadata?.stage, "cloning-repository");

    const metadataJson = JSON.stringify(failedEvent?.metadata ?? {});
    assert.ok(!metadataJson.includes(installationToken));
  });

  test("resolves a fresh credential on every deployment attempt, never reusing a stale one (redeploy simulation)", async () => {
    const app = makeApp("fresh-credential-per-deploy");
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
      resolveBranchCommit: async () => "c".repeat(40),
      listCommits: async () => ({ items: [], hasMore: false })
    };

    let mintCount = 0;
    const resolveCredential = async () => {
      mintCount += 1;
      // A distinct token every call — simulates resolveGithubToken minting
      // a genuinely fresh installation token each time, never a cached one.
      return { success: true as const, token: `ghs_fresh-token-${mintCount}`, source: "installation" as const };
    };

    const deps: GithubDeployDependencies = {
      ...baseDeps,
      githubClient,
      resolveCredential,
      gitExecutable: "/definitely-not-present/deployment-platform-test-git"
    };

    // First deployment.
    await deployFromGithub(deps, app.id);
    assert.equal(mintCount, 1);

    // A second, independent deployment attempt (simulating "Redeploy" or
    // a later "Deploy from GitHub" click) must resolve credentials again
    // — not reuse the first call's result.
    await deployFromGithub(deps, app.id);
    assert.equal(mintCount, 2);
  });

  test("never calls legacy stored-PAT decryption once a credential has already been resolved (structural)", () => {
    // Source-level assertion: the deploy service must accept
    // resolveCredential's already-resolved `credential.token` directly and
    // never separately re-read/re-derive it via a legacy PAT-only path
    // (getDecryptedGithubToken) inside the deployment function itself —
    // that logic belongs solely inside resolveGithubToken's own PAT
    // fallback branch, not duplicated here.
    const source = readFileSync(
      new URL("../services/github-deploy-service.ts", import.meta.url),
      "utf8"
    );
    assert.ok(!source.includes("getDecryptedGithubToken"));
    assert.ok(!source.includes("getProviderCredential"));
    assert.match(source, /token:\s*credential\.token/);
  });
});
