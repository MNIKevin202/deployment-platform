import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("deployment ledger (app_deployments)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-ledger-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeApp() {
    return appDatabase.createApp({
      name: "web",
      image: "deployment-app-1:aaaaaaaaaaaa",
      containerPort: 3000,
      containerName: "app-web"
    });
  }

  test("allocates monotonic per-app versions and moves is_current forward", () => {
    const app = makeApp();

    const v1 = appDatabase.recordDeployment({
      appId: app.id,
      imageTag: "deployment-app-1:aaaaaaaaaaaa",
      commitSha: "aaaaaaaaaaaa1111",
      commitMessage: "first",
      sourceKind: "github"
    });
    assert.equal(v1.version, 1);
    assert.equal(v1.isCurrent, true);

    const v2 = appDatabase.recordDeployment({
      appId: app.id,
      imageTag: "deployment-app-1:bbbbbbbbbbbb",
      commitSha: "bbbbbbbbbbbb2222",
      commitMessage: "second",
      sourceKind: "github"
    });
    assert.equal(v2.version, 2);
    assert.equal(v2.isCurrent, true);

    // Exactly one current row, and it is the newest.
    const current = appDatabase.getCurrentDeployment(app.id);
    assert.equal(current?.version, 2);

    const reFetchedV1 = appDatabase.getDeployment(app.id, 1);
    assert.equal(reFetchedV1?.isCurrent, false);
  });

  test("lists newest-first and records a revert as a new version", () => {
    const app = makeApp();

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

    const revert = appDatabase.recordDeployment({
      appId: app.id,
      imageTag: "deployment-app-1:aaaaaaaaaaaa",
      commitSha: "aaaaaaaaaaaa1111",
      commitMessage: "first",
      sourceKind: "github",
      revertOfVersion: 1
    });

    assert.equal(revert.version, 3);
    assert.equal(revert.revertOfVersion, 1);
    assert.equal(revert.imageTag, "deployment-app-1:aaaaaaaaaaaa");

    const list = appDatabase.listDeployments(app.id, 25);
    assert.deepEqual(
      list.map((d) => d.version),
      [3, 2, 1]
    );
    assert.equal(appDatabase.getCurrentDeployment(app.id)?.version, 3);
  });

  test("versions are scoped per app", () => {
    const app = makeApp();
    const other = appDatabase.createApp({
      name: "api",
      image: "deployment-app-2:cccccccccccc",
      containerPort: 4000,
      containerName: "app-api"
    });

    appDatabase.recordDeployment({
      appId: app.id,
      imageTag: "deployment-app-1:aaaaaaaaaaaa",
      commitSha: null,
      commitMessage: null,
      sourceKind: "github"
    });
    const otherV1 = appDatabase.recordDeployment({
      appId: other.id,
      imageTag: "deployment-app-2:cccccccccccc",
      commitSha: null,
      commitMessage: null,
      sourceKind: "github"
    });

    // Each app starts its own numbering at 1.
    assert.equal(otherV1.version, 1);
  });
});
