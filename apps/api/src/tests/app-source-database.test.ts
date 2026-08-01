import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("app sources (database layer)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-source-db-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
  });

  function cleanup() {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  function makeApp(name: string) {
    return appDatabase.createApp({
      name,
      image: "nginx:alpine",
      containerPort: 80,
      containerName: `app-${name}`
    });
  }

  function baseInput() {
    return {
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
      autoDeploy: false
    };
  }

  test("returns null when no source is linked", () => {
    const app = makeApp("app-one");
    assert.equal(appDatabase.getAppSource(app.id), null);
    cleanup();
  });

  test("creates a source link with validation starting unknown", () => {
    const app = makeApp("app-two");

    const created = appDatabase.upsertAppSource(app.id, baseInput());

    assert.equal(created.repositoryOwner, "octocat");
    assert.equal(created.repositoryName, "hello-world");
    assert.equal(created.branch, "main");
    assert.equal(created.validationStatus, "unknown");
    assert.equal(created.lastValidatedCommitSha, null);

    cleanup();
  });

  test("updates the source link in place — only one row per app", () => {
    const app = makeApp("app-three");

    appDatabase.upsertAppSource(app.id, baseInput());
    const updated = appDatabase.upsertAppSource(app.id, {
      ...baseInput(),
      branch: "develop",
      dockerfilePath: "docker/Dockerfile"
    });

    assert.equal(updated.branch, "develop");
    assert.equal(updated.dockerfilePath, "docker/Dockerfile");

    const count = appDatabase.db
      .prepare("SELECT COUNT(*) AS count FROM app_sources WHERE app_id = ?")
      .get(app.id) as { count: number };

    assert.equal(count.count, 1);

    cleanup();
  });

  test("changing the configuration resets validation back to unknown", () => {
    const app = makeApp("app-four");

    appDatabase.upsertAppSource(app.id, baseInput());
    appDatabase.updateAppSourceValidation(app.id, {
      validationStatus: "valid",
      validationError: null,
      lastValidatedCommitSha: "abc1234",
      lastValidatedAt: "2026-01-01T00:00:00.000Z"
    });

    const afterEdit = appDatabase.upsertAppSource(app.id, {
      ...baseInput(),
      branch: "release"
    });

    assert.equal(afterEdit.validationStatus, "unknown");
    assert.equal(afterEdit.lastValidatedCommitSha, null);
    assert.equal(afterEdit.lastValidatedAt, null);

    cleanup();
  });

  test("updateAppSourceValidation persists a successful validation result", () => {
    const app = makeApp("app-five");
    appDatabase.upsertAppSource(app.id, baseInput());

    appDatabase.updateAppSourceValidation(app.id, {
      validationStatus: "valid",
      validationError: null,
      lastValidatedCommitSha: "deadbeef",
      lastValidatedAt: "2026-01-01T00:00:00.000Z",
      repositoryVisibility: "public",
      repositoryId: "12345"
    });

    const result = appDatabase.getAppSource(app.id);
    assert.equal(result?.validationStatus, "valid");
    assert.equal(result?.lastValidatedCommitSha, "deadbeef");
    assert.equal(result?.repositoryVisibility, "public");
    assert.equal(result?.repositoryId, "12345");

    cleanup();
  });

  test("updateAppSourceValidation persists a failure with a sanitized error", () => {
    const app = makeApp("app-six");
    appDatabase.upsertAppSource(app.id, baseInput());

    appDatabase.updateAppSourceValidation(app.id, {
      validationStatus: "invalid",
      validationError: "Branch not found",
      lastValidatedCommitSha: null,
      lastValidatedAt: "2026-01-01T00:00:00.000Z"
    });

    const result = appDatabase.getAppSource(app.id);
    assert.equal(result?.validationStatus, "invalid");
    assert.equal(result?.validationError, "Branch not found");

    cleanup();
  });

  test("updateAppSourceValidation throws when no source is linked", () => {
    const app = makeApp("app-seven");

    assert.throws(() => {
      appDatabase.updateAppSourceValidation(app.id, {
        validationStatus: "valid",
        validationError: null,
        lastValidatedCommitSha: null,
        lastValidatedAt: null
      });
    });

    cleanup();
  });

  test("deleteAppSource removes only the tracking record", () => {
    const app = makeApp("app-eight");
    appDatabase.upsertAppSource(app.id, baseInput());

    appDatabase.deleteAppSource(app.id);

    assert.equal(appDatabase.getAppSource(app.id), null);

    cleanup();
  });

  test("cascades deletion when the owning app is deleted", () => {
    const app = makeApp("app-nine");
    appDatabase.upsertAppSource(app.id, baseInput());

    appDatabase.deleteApp(app.id);

    const remaining = appDatabase.db
      .prepare("SELECT COUNT(*) AS count FROM app_sources WHERE app_id = ?")
      .get(app.id) as { count: number };

    assert.equal(remaining.count, 0);

    cleanup();
  });

  test("deleting a provider credential does not touch app source metadata", () => {
    const app = makeApp("app-ten");
    appDatabase.upsertAppSource(app.id, baseInput());

    appDatabase.upsertProviderCredential({
      provider: "github",
      encryptedPayload: "payload",
      authenticatedUsername: "octocat",
      permissionsJson: null,
      lastValidatedAt: null
    });

    appDatabase.deleteProviderCredential("github");

    const stillLinked = appDatabase.getAppSource(app.id);
    assert.ok(stillLinked);
    assert.equal(stillLinked?.repositoryOwner, "octocat");

    cleanup();
  });

  test("a source stays scoped to its own app", () => {
    const appOne = makeApp("app-eleven");
    const appTwo = makeApp("app-twelve");

    appDatabase.upsertAppSource(appOne.id, baseInput());

    assert.equal(appDatabase.getAppSource(appTwo.id), null);
    assert.ok(appDatabase.getAppSource(appOne.id));

    cleanup();
  });

  test("persists the Phase 11 deployment fields (subdirectory, port, clone URL)", () => {
    const app = makeApp("app-thirteen");

    const created = appDatabase.upsertAppSource(app.id, {
      ...baseInput(),
      subdirectory: "services/api",
      containerPort: 4000
    });

    assert.equal(created.subdirectory, "services/api");
    assert.equal(created.containerPort, 4000);
    assert.equal(created.repositoryFullName, "octocat/hello-world");
    assert.equal(created.repositoryCloneUrl, "https://github.com/octocat/hello-world.git");
    assert.equal(created.buildStrategy, null);
    assert.equal(created.detectedProjectType, null);
    assert.equal(created.latestDeployedCommitSha, null);

    cleanup();
  });

  test("updateInspectionResult persists the detected strategy and remote commit", () => {
    const app = makeApp("app-fourteen");
    appDatabase.upsertAppSource(app.id, baseInput());

    appDatabase.updateInspectionResult(app.id, {
      buildStrategy: "nodejs",
      detectedProjectType: "nodejs",
      latestRemoteCommitSha: "abc1234"
    });

    const result = appDatabase.getAppSource(app.id);
    assert.equal(result?.buildStrategy, "nodejs");
    assert.equal(result?.detectedProjectType, "nodejs");
    assert.equal(result?.latestRemoteCommitSha, "abc1234");

    cleanup();
  });

  test("selectedStrategy persists an operator's manual override and is null by default", () => {
    const app = makeApp("app-selected-strategy-default");
    const created = appDatabase.upsertAppSource(app.id, baseInput());
    assert.equal(created.selectedStrategy, null);
    cleanup();
  });

  test("selectedStrategy survives a repository-inspection rerun — inspection only ever touches buildStrategy/detectedProjectType", () => {
    const app = makeApp("app-selected-strategy-survives-inspect");
    appDatabase.upsertAppSource(app.id, { ...baseInput(), selectedStrategy: "dockerfile" });

    // A fresh inspection detects "nodejs" (e.g. a monorepo with a root
    // package.json) — this must NEVER silently overwrite the operator's
    // manual "dockerfile" choice.
    appDatabase.updateInspectionResult(app.id, {
      buildStrategy: "nodejs",
      detectedProjectType: "nodejs",
      latestRemoteCommitSha: "abc1234"
    });

    const result = appDatabase.getAppSource(app.id);
    assert.equal(result?.buildStrategy, "nodejs", "the DETECTED strategy is still recorded faithfully");
    assert.equal(result?.selectedStrategy, "dockerfile", "the operator's manual choice must survive the inspection rerun");

    cleanup();
  });

  test("updateInspectionResult throws when no source is linked", () => {
    const app = makeApp("app-fifteen");
    assert.throws(() =>
      appDatabase.updateInspectionResult(app.id, {
        buildStrategy: "nodejs",
        detectedProjectType: "nodejs",
        latestRemoteCommitSha: "abc1234"
      })
    );
    cleanup();
  });

  test("a config change resets the inspection result back to null", () => {
    const app = makeApp("app-sixteen");
    appDatabase.upsertAppSource(app.id, baseInput());
    appDatabase.updateInspectionResult(app.id, {
      buildStrategy: "nodejs",
      detectedProjectType: "nodejs",
      latestRemoteCommitSha: "abc1234"
    });

    const afterEdit = appDatabase.upsertAppSource(app.id, { ...baseInput(), branch: "develop" });

    assert.equal(afterEdit.buildStrategy, null);
    assert.equal(afterEdit.detectedProjectType, null);
    assert.equal(afterEdit.latestRemoteCommitSha, null);

    cleanup();
  });

  test("changing selectedStrategy itself resets validation back to unknown, but does not silently discard the new choice", () => {
    const app = makeApp("app-change-selected-strategy");
    appDatabase.upsertAppSource(app.id, { ...baseInput(), selectedStrategy: "nodejs" });
    appDatabase.updateAppSourceValidation(app.id, {
      validationStatus: "valid",
      validationError: null,
      lastValidatedCommitSha: "abc1234",
      lastValidatedAt: new Date().toISOString()
    });

    const afterChange = appDatabase.upsertAppSource(app.id, { ...baseInput(), selectedStrategy: "dockerfile" });

    assert.equal(afterChange.selectedStrategy, "dockerfile");
    assert.equal(afterChange.validationStatus, "unknown");

    cleanup();
  });

  test("re-saving with an unrelated field change (e.g. container port) does not disturb a manually-selected strategy", () => {
    const app = makeApp("app-unrelated-change-preserves-strategy");
    appDatabase.upsertAppSource(app.id, { ...baseInput(), selectedStrategy: "dockerfile" });

    const afterPortChange = appDatabase.upsertAppSource(app.id, {
      ...baseInput(),
      selectedStrategy: "dockerfile",
      containerPort: 4319,
      containerPortSource: "manual"
    });

    assert.equal(afterPortChange.selectedStrategy, "dockerfile");
    assert.equal(afterPortChange.containerPort, 4319);

    cleanup();
  });

  test("updateDeployedCommit records what was actually deployed", () => {
    const app = makeApp("app-seventeen");
    appDatabase.upsertAppSource(app.id, baseInput());

    appDatabase.updateDeployedCommit(app.id, {
      commitSha: "deadbeef1234",
      commitMessage: "Fix the thing",
      deployedAt: "2026-01-02T00:00:00.000Z"
    });

    const result = appDatabase.getAppSource(app.id);
    assert.equal(result?.latestDeployedCommitSha, "deadbeef1234");
    assert.equal(result?.latestDeployedCommitMessage, "Fix the thing");
    assert.equal(result?.latestDeployedAt, "2026-01-02T00:00:00.000Z");

    cleanup();
  });

  test("a config change does NOT erase deployment history", () => {
    const app = makeApp("app-eighteen");
    appDatabase.upsertAppSource(app.id, baseInput());
    appDatabase.updateDeployedCommit(app.id, {
      commitSha: "deadbeef1234",
      commitMessage: "Fix the thing",
      deployedAt: "2026-01-02T00:00:00.000Z"
    });

    const afterEdit = appDatabase.upsertAppSource(app.id, { ...baseInput(), branch: "develop" });

    assert.equal(afterEdit.latestDeployedCommitSha, "deadbeef1234");
    assert.equal(afterEdit.latestDeployedCommitMessage, "Fix the thing");

    cleanup();
  });

  test("the deployment lock is durable, per-app, and cannot be double-acquired", () => {
    const appOne = makeApp("app-nineteen");
    const appTwo = makeApp("app-twenty");

    assert.equal(appDatabase.acquireDeploymentLock(appOne.id), true);
    assert.equal(appDatabase.isDeploymentLocked(appOne.id), true);
    assert.equal(appDatabase.acquireDeploymentLock(appOne.id), false, "a second acquire for the same app must fail");

    assert.equal(appDatabase.acquireDeploymentLock(appTwo.id), true, "locks are scoped per app");

    appDatabase.releaseDeploymentLock(appOne.id);
    assert.equal(appDatabase.isDeploymentLocked(appOne.id), false);
    assert.equal(appDatabase.acquireDeploymentLock(appOne.id), true, "released locks can be re-acquired");

    cleanup();
  });

  test("releasing a lock that was never acquired is a harmless no-op", () => {
    const app = makeApp("app-twenty-one");
    assert.doesNotThrow(() => appDatabase.releaseDeploymentLock(app.id));
    cleanup();
  });

  test("the startup sweep clears EVERY lock, however recent — an orphan from a platform restart included", () => {
    const appOne = makeApp("app-twenty-two");
    const appTwo = makeApp("app-twenty-three");

    // Both locks are brand new — exactly the case an age-gated sweep would
    // wrongly leave in place. A deploy of the platform itself restarts the
    // API mid-build, orphaning a seconds-old lock; the process that boots
    // afterward cannot own any deploy, so every lock is stale.
    assert.equal(appDatabase.acquireDeploymentLock(appOne.id), true);
    assert.equal(appDatabase.acquireDeploymentLock(appTwo.id), true);

    const cleared = appDatabase.releaseStaleDeploymentLocks();

    assert.equal(cleared, 2, "both fresh orphans are reclaimed");
    assert.equal(appDatabase.isDeploymentLocked(appOne.id), false);
    assert.equal(appDatabase.isDeploymentLocked(appTwo.id), false);
    assert.equal(
      appDatabase.acquireDeploymentLock(appOne.id),
      true,
      "the app can deploy again once the orphaned lock is swept"
    );

    cleanup();
  });
});
