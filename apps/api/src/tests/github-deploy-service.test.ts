import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { deployFromGithub, type GithubDeployDependencies } from "../services/github-deploy-service.js";
import { BuildImageError } from "../services/github-deploy-docker-ops.js";
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
    containerExists: fail,
    stopContainer: fail,
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

// ============================================================
// Manual strategy override reaches the REAL build (not the mocked-away
// clone/build pipeline the guard-clause tests above use) — a real local
// git repository, cloned via cloneUrlOverride (file://, no network, no
// live GitHub repository involved), so inspectCheckoutDirectory runs
// against real files and prepareBuildPlan resolves real paths. Stops
// right after the real build call by making createContainer throw a
// deliberate, expected error — proving the strategy override reached
// dockerOps.buildImage with the correct effective path, without ever
// touching a real container.
// ============================================================

function buildFakeBareRepoWithRootPackageJsonAndNestedDockerfile(): string {
  const scratch = mkdtempSync(join(tmpdir(), "strategy-override-fixture-"));
  const workRepo = join(scratch, "work");
  mkdirSync(join(workRepo, "tools", "roadmap-studio"), { recursive: true });

  // A package.json at the repository ROOT — this is what makes
  // inspection recommend "nodejs" by default.
  writeFileSync(
    join(workRepo, "package.json"),
    JSON.stringify({ name: "roadmapstudio-web", scripts: { start: "node index.js" } })
  );

  // The real, nested Dockerfile the operator wants to build with
  // instead — exact roadmapstudio-web fixture shape: subdirectory ".",
  // dockerfilePath "tools/roadmap-studio/Dockerfile", buildContext ".".
  writeFileSync(join(workRepo, "tools", "roadmap-studio", "Dockerfile"), "FROM scratch\n");

  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: scratch };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workRepo, env });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: workRepo, env });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: workRepo, env });
  execFileSync("git", ["add", "-A"], { cwd: workRepo, env });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: workRepo, env });

  const bareRepo = join(scratch, "repo.git");
  execFileSync("git", ["clone", "-q", "--bare", workRepo, bareRepo], { env });

  return bareRepo;
}

describe("deployFromGithub — manual strategy override reaches the real build (regression fixture)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let bareRepo: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "github-deploy-strategy-override-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
    bareRepo = buildFakeBareRepoWithRootPackageJsonAndNestedDockerfile();
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(join(bareRepo, ".."), { recursive: true, force: true });
  });

  function makeApp(name: string) {
    return appDatabase.createApp({
      name,
      image: "nginx:alpine",
      containerPort: 4319,
      containerName: `app-${name}`
    });
  }

  test("a repository with root package.json (Node.js-detected) manually selects dockerfile, and the real build uses the nested Dockerfile — not the auto-detected Node.js strategy", async () => {
    const app = makeApp("roadmapstudio-web-override");
    appDatabase.upsertAppSource(app.id, {
      provider: "github",
      repositoryOwner: "MNIKevin202",
      repositoryName: "DeploymentPlatformInstaller",
      repositoryFullName: "MNIKevin202/DeploymentPlatformInstaller",
      repositoryCloneUrl: "https://github.com/MNIKevin202/DeploymentPlatformInstaller.git",
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      subdirectory: ".",
      deploymentMode: "dockerfile",
      dockerfilePath: "tools/roadmap-studio/Dockerfile",
      buildContext: ".",
      selectedStrategy: "dockerfile",
      containerPort: 4319,
      autoDeploy: false
    });

    const githubClient: SourceProviderClient = {
      ...unusedGithubClient(),
      resolveBranchCommit: async () => "d".repeat(40),
      listCommits: async () => ({ items: [], hasMore: false })
    };

    const buildImageCalls: Array<{ contextPath: string; dockerfileRelativePath: string; dockerfileContent: string }> =
      [];

    const dockerOps: GithubDeployDependencies["dockerOps"] = {
      ...unusedDockerOps(),
      async imageExists() {
        return false;
      },
      async buildImage(input) {
        // Read the Dockerfile NOW, while the checkout still exists —
        // deployFromGithub removes it in its own `finally` block
        // immediately after this call returns.
        const dockerfileContent = readFileSync(join(input.contextPath, input.dockerfileRelativePath), "utf8");
        buildImageCalls.push({
          contextPath: input.contextPath,
          dockerfileRelativePath: input.dockerfileRelativePath,
          dockerfileContent
        });
        return { log: "", truncated: false };
      },
      async createContainer() {
        // Deliberately stop here — the whole point of this test is to
        // observe the buildImage call, never to touch a real container.
        throw new Error("expected-stop-after-build");
      }
    };

    const recordedEvents: Array<{ eventType: string; message: string }> = [];
    const recordEvent: RecordEventFn = (input) => {
      recordedEvents.push({ eventType: input.eventType, message: input.message });
    };

    const deps: GithubDeployDependencies = {
      appDatabase,
      dockerOps,
      githubClient,
      resolveCredential: async () => ({ success: true, token: "ghs_fake-fixture-token", source: "installation" }),
      reconcileRouting: async () => ({ lastReconcileSucceeded: true, lastError: null }),
      recordEvent,
      cloneUrlOverride: `file://${bareRepo}`
    };

    const result = await deployFromGithub(deps, app.id);

    // Stopped exactly where expected — proves the pipeline reached the
    // real build (not a pre-clone/pre-inspection failure) and never
    // touched a real container beyond that.
    assert.equal(result.success, false);
    assert.match(result.message, /expected-stop-after-build/);
    assert.ok(recordedEvents.some((e) => e.eventType === "github-deploy-failed"));

    assert.equal(buildImageCalls.length, 1);
    // The effective build context is the repository root (subdirectory
    // "."), and the effective Dockerfile — join(contextPath,
    // dockerfileRelativePath) — is the real, on-disk nested Dockerfile
    // inside tools/roadmap-studio, proving the MANUAL "dockerfile"
    // selection was what actually got built, not the auto-detected
    // "nodejs" recommendation (there is no generated Node.js Dockerfile
    // anywhere in this fixture — a nodejs build would have failed
    // differently, with no start-script-based image at all).
    const { dockerfileRelativePath, dockerfileContent } = buildImageCalls[0]!;
    assert.equal(dockerfileRelativePath, join("tools", "roadmap-studio", "Dockerfile"));
    assert.equal(dockerfileContent, "FROM scratch\n");

    // The DETECTED strategy (from real inspection) is still recorded
    // faithfully as "nodejs" — inspection never lies about what it
    // found — while selectedStrategy (the operator's own choice) is
    // what determined the actual build, confirmed above.
    const source = appDatabase.getAppSource(app.id);
    assert.equal(source?.buildStrategy, "nodejs");
    assert.equal(source?.selectedStrategy, "dockerfile");
  });

  test("a corrupt-cache build error triggers exactly one no-cache retry", async () => {
    const app = makeApp("staxxio-cache-recovery");
    appDatabase.upsertAppSource(app.id, {
      provider: "github",
      repositoryOwner: "MNIKevin202",
      repositoryName: "Staxxio",
      repositoryFullName: "MNIKevin202/Staxxio",
      repositoryCloneUrl: "https://github.com/MNIKevin202/Staxxio.git",
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      subdirectory: ".",
      deploymentMode: "dockerfile",
      dockerfilePath: "tools/roadmap-studio/Dockerfile",
      buildContext: ".",
      selectedStrategy: "dockerfile",
      containerPort: 4319,
      autoDeploy: false
    });

    const githubClient: SourceProviderClient = {
      ...unusedGithubClient(),
      resolveBranchCommit: async () => "d".repeat(40),
      listCommits: async () => ({ items: [], hasMore: false })
    };

    const noCacheFlags: Array<boolean | undefined> = [];
    const timeouts: number[] = [];
    const dockerOps: GithubDeployDependencies["dockerOps"] = {
      ...unusedDockerOps(),
      async imageExists() {
        return false;
      },
      async buildImage(input) {
        noCacheFlags.push(input.noCache);
        timeouts.push(input.timeoutMs);
        // First (cached) attempt hits the classic corrupt-snapshot error.
        if (noCacheFlags.length === 1) {
          throw new BuildImageError(
            "NotFound: parent snapshot sha256:37d1b91b does not exist: not found",
            "build log"
          );
        }
        // The no-cache retry succeeds; stop the pipeline right after so the
        // test observes the retry without touching a real container.
        return { log: "ok", truncated: false };
      },
      async createContainer() {
        throw new Error("expected-stop-after-build");
      }
    };

    const recordedEvents: Array<{ eventType: string; severity: string; message: string }> = [];
    const deps: GithubDeployDependencies = {
      appDatabase,
      dockerOps,
      githubClient,
      resolveCredential: async () => ({ success: true, token: "ghs_fake", source: "installation" }),
      reconcileRouting: async () => ({ lastReconcileSucceeded: true, lastError: null }),
      recordEvent: (input) =>
        recordedEvents.push({
          eventType: input.eventType,
          severity: input.severity ?? "info",
          message: input.message
        }),
      cloneUrlOverride: `file://${bareRepo}`
    };

    const result = await deployFromGithub(deps, app.id);

    // Retried exactly once: first WITH cache (undefined/false), then WITHOUT.
    assert.equal(noCacheFlags.length, 2);
    assert.ok(!noCacheFlags[0], "first attempt uses the cache");
    assert.equal(noCacheFlags[1], true, "the retry disables the cache");

    // The no-cache retry — which rebuilds every layer — gets MORE time than
    // the cached attempt, so the recovery isn't itself killed by a timeout
    // tuned for fast cached builds (the exact way staxxio timed out).
    assert.ok(
      timeouts[1] > timeouts[0],
      "the no-cache retry gets a longer build timeout than the cached attempt"
    );

    // The retry got past the build and stopped at the container step, i.e.
    // the corrupt-cache error did NOT surface as the deploy failure.
    assert.match(result.message, /expected-stop-after-build/);
    assert.ok(
      recordedEvents.some((e) => e.severity === "warning" && /corrupt/i.test(e.message)),
      "the operator is told the cache was corrupt and a no-cache retry ran"
    );
  });

  test("a genuine build failure is NOT retried with no-cache", async () => {
    const app = makeApp("staxxio-real-failure");
    appDatabase.upsertAppSource(app.id, {
      provider: "github",
      repositoryOwner: "MNIKevin202",
      repositoryName: "Staxxio",
      repositoryFullName: "MNIKevin202/Staxxio",
      repositoryCloneUrl: "https://github.com/MNIKevin202/Staxxio.git",
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      subdirectory: ".",
      deploymentMode: "dockerfile",
      dockerfilePath: "tools/roadmap-studio/Dockerfile",
      buildContext: ".",
      selectedStrategy: "dockerfile",
      containerPort: 4319,
      autoDeploy: false
    });

    const githubClient: SourceProviderClient = {
      ...unusedGithubClient(),
      resolveBranchCommit: async () => "e".repeat(40),
      listCommits: async () => ({ items: [], hasMore: false })
    };

    let buildCalls = 0;
    const dockerOps: GithubDeployDependencies["dockerOps"] = {
      ...unusedDockerOps(),
      async imageExists() {
        return false;
      },
      async buildImage() {
        buildCalls += 1;
        // A real code failure — the exact staxxio symptom — must be
        // reported, never silently retried and hidden.
        throw new BuildImageError(
          "The command '/bin/sh -c npm run build' returned a non-zero code: 1",
          "build log"
        );
      }
    };

    const deps: GithubDeployDependencies = {
      appDatabase,
      dockerOps,
      githubClient,
      resolveCredential: async () => ({ success: true, token: "ghs_fake", source: "installation" }),
      reconcileRouting: async () => ({ lastReconcileSucceeded: true, lastError: null }),
      recordEvent: () => {},
      cloneUrlOverride: `file://${bareRepo}`
    };

    const result = await deployFromGithub(deps, app.id);

    assert.equal(buildCalls, 1, "a real failure is built once, never retried");
    assert.equal(result.success, false);
    assert.match(result.message, /npm run build/);
  });
});
