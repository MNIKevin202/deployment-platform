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
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      deploymentMode: "dockerfile" as const,
      dockerfilePath: "Dockerfile",
      buildContext: ".",
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
});
