import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import {
  removeAppSource,
  saveAppSource,
  revalidateAppSource,
  validateAppSource,
  type AppSourceServiceDeps
} from "../services/app-source-service.js";
import {
  SourceClientError,
  type SourceBranch,
  type SourceProviderClient,
  type SourceRepository
} from "../services/source-provider.js";
import type { ResolvedGithubToken } from "../services/github-token-service.js";
import type { RecordEventFn, RecordEventInput } from "../services/deployment-event-service.js";

const FAKE_TOKEN = "github_pat_should_never_leak_into_any_event_or_error";

interface FakeGithubOptions {
  repository?: Partial<SourceRepository>;
  getRepositoryFails?: SourceClientError;
  branchSha?: string;
  resolveBranchFails?: SourceClientError;
  dockerfileExists?: boolean;
  pathExistsFails?: SourceClientError;
}

function createFakeGithubClient(
  options: FakeGithubOptions = {},
  pathExistsCalls?: string[]
): SourceProviderClient {
  const repo: SourceRepository = {
    id: "1",
    owner: "octocat",
    name: "hello-world",
    fullName: "octocat/hello-world",
    private: false,
    archived: false,
    description: null,
    defaultBranch: "main",
    htmlUrl: "https://github.com/octocat/hello-world",
    pushedAt: null,
    updatedAt: null,
    ...options.repository
  };

  return {
    provider: "github",
    async validateCredential() {
      return { username: "octocat", htmlUrl: "https://github.com/octocat" };
    },
    async listRepositories() {
      return { items: [repo], hasMore: false };
    },
    async getRepository() {
      if (options.getRepositoryFails) {
        throw options.getRepositoryFails;
      }
      return repo;
    },
    async listBranches() {
      const branch: SourceBranch = { name: "main", commitSha: options.branchSha ?? "abc1234", protected: false };
      return { items: [branch], hasMore: false };
    },
    async listCommits() {
      return { items: [], hasMore: false };
    },
    async resolveBranchCommit() {
      if (options.resolveBranchFails) {
        throw options.resolveBranchFails;
      }
      return options.branchSha ?? "abc1234567890";
    },
    async pathExists(_token, _owner, _repo, _ref, path) {
      pathExistsCalls?.push(path);
      if (options.pathExistsFails) {
        throw options.pathExistsFails;
      }
      return options.dockerfileExists ?? true;
    },
    async getFileContents() {
      // Never called by validateAppSource/saveAppSource — inspection is a
      // separate flow (see repository-inspection-service.test.ts). Throw
      // rather than return a plausible-looking value so a future caller
      // that starts relying on this fails loudly instead of silently
      // reading fake content.
      throw new Error("getFileContents is not used by these tests");
    }
  };
}

function createEventTracker(): { recordEvent: RecordEventFn; events: RecordEventInput[] } {
  const events: RecordEventInput[] = [];
  return { events, recordEvent: (input) => events.push(input) };
}

async function availableCredential(): Promise<ResolvedGithubToken> {
  return { success: true, token: FAKE_TOKEN, source: "pat" };
}

async function unavailableCredential(): Promise<ResolvedGithubToken> {
  return { success: false, credentialStatus: "not-configured" };
}

const noopLogger = { error: () => {} };

describe("validateAppSource", () => {
  const baseSource = {
    repositoryOwner: "octocat",
    repositoryName: "hello-world",
    branch: "main",
    deploymentMode: "dockerfile" as const,
    dockerfilePath: "Dockerfile",
    subdirectory: "."
  };

  test("succeeds for a fully valid linked source and resolves the current commit", async () => {
    const githubClient = createFakeGithubClient({ branchSha: "deadbeef123", dockerfileExists: true });

    const result = await validateAppSource(
      { githubClient, resolveCredential: availableCredential },
      baseSource
    );

    assert.equal(result.status, "valid");
    assert.equal(result.commitSha, "deadbeef123");
    assert.equal(result.repositoryVisibility, "public");
    assert.equal(result.error, null);
  });

  test("fails clearly when no GitHub credential is available, without calling GitHub", async () => {
    let called = false;
    const githubClient = createFakeGithubClient();
    const trackedClient: SourceProviderClient = {
      ...githubClient,
      getRepository: async (...args) => {
        called = true;
        return githubClient.getRepository(...args);
      }
    };

    const result = await validateAppSource(
      { githubClient: trackedClient, resolveCredential: unavailableCredential },
      baseSource
    );

    assert.equal(result.status, "invalid");
    assert.match(result.error ?? "", /not connected/i);
    assert.equal(called, false);
  });

  test("fails when the repository is inaccessible", async () => {
    const githubClient = createFakeGithubClient({
      getRepositoryFails: new SourceClientError("not-found", "The requested GitHub resource was not found.")
    });

    const result = await validateAppSource(
      { githubClient, resolveCredential: availableCredential },
      baseSource
    );

    assert.equal(result.status, "invalid");
    assert.match(result.error ?? "", /not found/i);
    assert.equal(result.commitSha, null);
  });

  test("fails when the branch does not exist", async () => {
    const githubClient = createFakeGithubClient({
      resolveBranchFails: new SourceClientError("not-found", "The requested GitHub resource was not found.")
    });

    const result = await validateAppSource(
      { githubClient, resolveCredential: availableCredential },
      baseSource
    );

    assert.equal(result.status, "invalid");
    assert.equal(result.commitSha, null);
    // Repository visibility is still known even though the branch failed.
    assert.equal(result.repositoryVisibility, "public");
  });

  test("fails when the Dockerfile is missing at the resolved commit", async () => {
    const githubClient = createFakeGithubClient({ dockerfileExists: false, branchSha: "commit123" });

    const result = await validateAppSource(
      { githubClient, resolveCredential: availableCredential },
      baseSource
    );

    assert.equal(result.status, "invalid");
    assert.match(result.error ?? "", /Dockerfile not found/);
    // The commit was still resolved even though the Dockerfile is missing.
    assert.equal(result.commitSha, "commit123");
  });

  test("checks the Dockerfile inside the configured subdirectory, not the repo root", async () => {
    const pathExistsCalls: string[] = [];
    const githubClient = createFakeGithubClient({ dockerfileExists: true }, pathExistsCalls);

    const result = await validateAppSource(
      { githubClient, resolveCredential: availableCredential },
      { ...baseSource, subdirectory: "tools/roadmap-studio", dockerfilePath: "Dockerfile" }
    );

    assert.equal(result.status, "valid");
    assert.deepEqual(pathExistsCalls, ["tools/roadmap-studio/Dockerfile"]);
  });

  test("regression fixture: roadmapstudio-web (subdirectory tools/roadmap-studio, dockerfilePath Dockerfile) validates against the effective nested path", async () => {
    const pathExistsCalls: string[] = [];
    const githubClient = createFakeGithubClient({ dockerfileExists: true }, pathExistsCalls);

    const result = await validateAppSource(
      { githubClient, resolveCredential: availableCredential },
      {
        repositoryOwner: "MNIKevin202",
        repositoryName: "DeploymentPlatformInstaller",
        branch: "main",
        deploymentMode: "dockerfile",
        dockerfilePath: "Dockerfile",
        subdirectory: "tools/roadmap-studio"
      }
    );

    assert.equal(result.status, "valid");
    assert.deepEqual(pathExistsCalls, ["tools/roadmap-studio/Dockerfile"]);
  });

  test("a Dockerfile missing from the configured subdirectory fails with the EFFECTIVE path shown, not the raw dockerfilePath (requirement 8)", async () => {
    const pathExistsCalls: string[] = [];
    const githubClient = createFakeGithubClient({ dockerfileExists: false }, pathExistsCalls);

    const result = await validateAppSource(
      { githubClient, resolveCredential: availableCredential },
      { ...baseSource, subdirectory: "tools/roadmap-studio", dockerfilePath: "Dockerfile" }
    );

    assert.equal(result.status, "invalid");
    assert.match(result.error ?? "", /Dockerfile not found at "tools\/roadmap-studio\/Dockerfile"/);
    assert.deepEqual(pathExistsCalls, ["tools/roadmap-studio/Dockerfile"]);
  });

  test("a nested Dockerfile path resolves relative to the subdirectory, not the repo root", async () => {
    const pathExistsCalls: string[] = [];
    const githubClient = createFakeGithubClient({ dockerfileExists: true }, pathExistsCalls);

    const result = await validateAppSource(
      { githubClient, resolveCredential: availableCredential },
      { ...baseSource, subdirectory: "tools/roadmap-studio", dockerfilePath: "docker/Dockerfile.prod" }
    );

    assert.equal(result.status, "valid");
    assert.deepEqual(pathExistsCalls, ["tools/roadmap-studio/docker/Dockerfile.prod"]);
  });

  test("skips the Dockerfile check entirely for prebuilt-image mode", async () => {
    let pathExistsCalled = false;
    const githubClient = createFakeGithubClient();
    const trackedClient: SourceProviderClient = {
      ...githubClient,
      pathExists: async (...args) => {
        pathExistsCalled = true;
        return githubClient.pathExists(...args);
      }
    };

    const result = await validateAppSource(
      { githubClient: trackedClient, resolveCredential: availableCredential },
      { ...baseSource, deploymentMode: "prebuilt-image" }
    );

    assert.equal(result.status, "valid");
    assert.equal(pathExistsCalled, false);
  });
});

describe("saveAppSource / revalidateAppSource / removeAppSource", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-source-service-test-"));
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
      containerPort: 80,
      containerName: `app-${name}`
    });
  }

  function deps(overrides: Partial<AppSourceServiceDeps> = {}): AppSourceServiceDeps {
    const { recordEvent } = createEventTracker();
    return {
      appDatabase,
      githubClient: createFakeGithubClient(),
      resolveCredential: availableCredential,
      recordEvent,
      logger: noopLogger,
      ...overrides
    };
  }

  test("persists a successful validation and records source-linked + source-validation-succeeded", async () => {
    const app = makeApp("app-one");
    const { recordEvent, events } = createEventTracker();

    const result = await saveAppSource(
      deps({ recordEvent }),
      app.id,
      {
        repositoryOwner: "octocat",
        repositoryName: "hello-world",
        branch: "main",
        subdirectory: "",
        deploymentMode: "dockerfile",
        dockerfilePath: "Dockerfile",
        buildContext: ".",
        autoDeploy: false
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.source?.validationStatus, "valid");
    assert.ok(result.source?.lastValidatedCommitSha);

    assert.ok(events.some((e) => e.eventType === "source-linked"));
    assert.ok(events.some((e) => e.eventType === "source-validation-succeeded"));
  });

  test("persists a failed validation with a sanitized error and records source-validation-failed", async () => {
    const app = makeApp("app-two");
    const { recordEvent, events } = createEventTracker();

    const result = await saveAppSource(
      deps({
        recordEvent,
        githubClient: createFakeGithubClient({ dockerfileExists: false })
      }),
      app.id,
      {
        repositoryOwner: "octocat",
        repositoryName: "hello-world",
        branch: "main",
        subdirectory: "",
        deploymentMode: "dockerfile",
        dockerfilePath: "Dockerfile",
        buildContext: ".",
        autoDeploy: false
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.source?.validationStatus, "invalid");
    assert.match(result.source?.validationError ?? "", /Dockerfile not found/);

    const failureEvent = events.find((e) => e.eventType === "source-validation-failed");
    assert.ok(failureEvent);
    assert.equal(failureEvent?.severity, "warning");
  });

  test("saveAppSource validates against the configured subdirectory, matching the app's real roadmapstudio-web fixture", async () => {
    const app = makeApp("roadmapstudio-web");
    const { recordEvent, events } = createEventTracker();
    const pathExistsCalls: string[] = [];

    const result = await saveAppSource(
      deps({
        recordEvent,
        githubClient: createFakeGithubClient({ dockerfileExists: true }, pathExistsCalls)
      }),
      app.id,
      {
        repositoryOwner: "MNIKevin202",
        repositoryName: "DeploymentPlatformInstaller",
        branch: "main",
        subdirectory: "tools/roadmap-studio",
        deploymentMode: "dockerfile",
        dockerfilePath: "Dockerfile",
        buildContext: ".",
        autoDeploy: false
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.source?.validationStatus, "valid");
    assert.equal(result.source?.validationError, null);
    assert.deepEqual(pathExistsCalls, ["tools/roadmap-studio/Dockerfile"]);
    assert.ok(events.some((e) => e.eventType === "source-validation-succeeded"));
  });

  test("revalidateAppSource (\"Validate Again\") re-checks against the same subdirectory-joined path as the original save", async () => {
    const app = makeApp("roadmapstudio-web-revalidate");
    const pathExistsCalls: string[] = [];

    await saveAppSource(
      deps({ githubClient: createFakeGithubClient({ dockerfileExists: true }) }),
      app.id,
      {
        repositoryOwner: "MNIKevin202",
        repositoryName: "DeploymentPlatformInstaller",
        branch: "main",
        subdirectory: "tools/roadmap-studio",
        deploymentMode: "dockerfile",
        dockerfilePath: "Dockerfile",
        buildContext: ".",
        autoDeploy: false
      }
    );

    const result = await revalidateAppSource(
      deps({ githubClient: createFakeGithubClient({ dockerfileExists: true }, pathExistsCalls) }),
      app.id
    );

    assert.equal(result.success, true);
    assert.equal(result.source?.validationStatus, "valid");
    assert.deepEqual(pathExistsCalls, ["tools/roadmap-studio/Dockerfile"]);
  });

  test("records source-updated (not source-linked) when replacing an existing link", async () => {
    const app = makeApp("app-three");
    const { recordEvent, events } = createEventTracker();
    const d = deps({ recordEvent });

    await saveAppSource(d, app.id, {
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      branch: "main",
      subdirectory: "",
      deploymentMode: "dockerfile",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      autoDeploy: false
    });

    events.length = 0;

    await saveAppSource(d, app.id, {
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      branch: "develop",
      subdirectory: "",
      deploymentMode: "dockerfile",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      autoDeploy: false
    });

    assert.ok(events.some((e) => e.eventType === "source-updated"));
    assert.ok(!events.some((e) => e.eventType === "source-linked"));
  });

  test("returns 404 when saving a source for a nonexistent app", async () => {
    const result = await saveAppSource(deps(), 999999, {
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      branch: "main",
      subdirectory: "",
      deploymentMode: "prebuilt-image",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      autoDeploy: false
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 404);
  });

  test("revalidateAppSource re-runs validation without changing the configuration", async () => {
    const app = makeApp("app-four");
    const d = deps({ githubClient: createFakeGithubClient({ dockerfileExists: false }) });

    await saveAppSource(d, app.id, {
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      branch: "main",
      subdirectory: "",
      deploymentMode: "dockerfile",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      autoDeploy: false
    });

    assert.equal(appDatabase.getAppSource(app.id)?.validationStatus, "invalid");

    // Fix the underlying repository (Dockerfile now exists) and validate again.
    const fixedDeps = { ...d, githubClient: createFakeGithubClient({ dockerfileExists: true }) };
    const result = await revalidateAppSource(fixedDeps, app.id);

    assert.equal(result.success, true);
    assert.equal(result.source?.validationStatus, "valid");
    // Configuration itself is untouched by revalidation.
    assert.equal(result.source?.branch, "main");
  });

  test("revalidateAppSource returns 404 when no source is linked", async () => {
    const app = makeApp("app-five");
    const result = await revalidateAppSource(deps(), app.id);

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 404);
  });

  test("removeAppSource deletes the link and records source-removed", async () => {
    const app = makeApp("app-six");
    const { recordEvent, events } = createEventTracker();
    const d = deps({ recordEvent });

    await saveAppSource(d, app.id, {
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      branch: "main",
      subdirectory: "",
      deploymentMode: "prebuilt-image",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      autoDeploy: false
    });

    events.length = 0;

    const result = removeAppSource(d, app.id);

    assert.equal(result.success, true);
    assert.equal(appDatabase.getAppSource(app.id), null);
    assert.ok(events.some((e) => e.eventType === "source-removed"));
  });

  test("never includes the GitHub token in any recorded event", async () => {
    const app = makeApp("app-seven");
    const { recordEvent, events } = createEventTracker();

    await saveAppSource(deps({ recordEvent }), app.id, {
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      branch: "main",
      subdirectory: "",
      deploymentMode: "dockerfile",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      autoDeploy: false
    });

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(FAKE_TOKEN));
  });
});
