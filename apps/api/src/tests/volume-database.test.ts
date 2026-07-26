import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("app volumes (database layer)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-volume-test-"));
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

  test("creates and lists app volumes with correct defaults", () => {
    const app = makeApp("app-one");

    const created = appDatabase.createAppVolume({
      appId: app.id,
      volumeName: "app-one-data",
      containerPath: "/data",
      readOnly: false
    });

    assert.equal(created.appId, app.id);
    assert.equal(created.volumeName, "app-one-data");
    assert.equal(created.containerPath, "/data");
    assert.equal(created.readOnly, false);

    const all = appDatabase.listAppVolumes(app.id);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], created);

    cleanup();
  });

  test("rejects a duplicate container path for the same app", () => {
    const app = makeApp("app-two");

    appDatabase.createAppVolume({
      appId: app.id,
      volumeName: "app-two-data",
      containerPath: "/data",
      readOnly: false
    });

    assert.throws(() => {
      appDatabase.createAppVolume({
        appId: app.id,
        volumeName: "app-two-data-2",
        containerPath: "/data",
        readOnly: false
      });
    });

    cleanup();
  });

  test("allows the same container path across two different apps", () => {
    const appOne = makeApp("app-three");
    const appTwo = makeApp("app-four");

    appDatabase.createAppVolume({
      appId: appOne.id,
      volumeName: "app-three-data",
      containerPath: "/data",
      readOnly: false
    });

    appDatabase.createAppVolume({
      appId: appTwo.id,
      volumeName: "app-four-data",
      containerPath: "/data",
      readOnly: false
    });

    assert.equal(appDatabase.listAppVolumes(appOne.id).length, 1);
    assert.equal(appDatabase.listAppVolumes(appTwo.id).length, 1);

    cleanup();
  });

  test("rejects a duplicate volume name across different apps (global uniqueness)", () => {
    const appOne = makeApp("app-five");
    const appTwo = makeApp("app-six");

    appDatabase.createAppVolume({
      appId: appOne.id,
      volumeName: "shared-name",
      containerPath: "/data",
      readOnly: false
    });

    assert.throws(() => {
      appDatabase.createAppVolume({
        appId: appTwo.id,
        volumeName: "shared-name",
        containerPath: "/config",
        readOnly: false
      });
    });

    cleanup();
  });

  test("updates container path and read-only flag, leaves volume name untouched", () => {
    const app = makeApp("app-seven");

    const created = appDatabase.createAppVolume({
      appId: app.id,
      volumeName: "app-seven-data",
      containerPath: "/data",
      readOnly: false
    });

    appDatabase.updateAppVolume(created.id, {
      containerPath: "/app/data",
      readOnly: true
    });

    const updated = appDatabase.getAppVolumeById(created.id);
    assert.equal(updated?.containerPath, "/app/data");
    assert.equal(updated?.readOnly, true);
    assert.equal(updated?.volumeName, "app-seven-data");

    cleanup();
  });

  test("deletes the tracking record only — this layer never touches Docker", () => {
    const app = makeApp("app-eight");

    const created = appDatabase.createAppVolume({
      appId: app.id,
      volumeName: "app-eight-data",
      containerPath: "/data",
      readOnly: false
    });

    appDatabase.deleteAppVolume(created.id);

    assert.equal(appDatabase.getAppVolumeById(created.id), null);
    assert.equal(appDatabase.listAppVolumes(app.id).length, 0);

    cleanup();
  });

  test("cascades volume-record deletion when the owning app is deleted", () => {
    const app = makeApp("app-nine");

    const created = appDatabase.createAppVolume({
      appId: app.id,
      volumeName: "app-nine-data",
      containerPath: "/data",
      readOnly: false
    });

    appDatabase.deleteApp(app.id);

    assert.equal(appDatabase.getAppVolumeById(created.id), null);

    cleanup();
  });

  test("keeps volumes scoped — one app's volumes never leak into another's list", () => {
    const appOne = makeApp("app-ten");
    const appTwo = makeApp("app-eleven");

    appDatabase.createAppVolume({
      appId: appOne.id,
      volumeName: "app-ten-data",
      containerPath: "/data",
      readOnly: false
    });

    assert.equal(appDatabase.listAppVolumes(appTwo.id).length, 0);
    assert.equal(appDatabase.listAppVolumes(appOne.id).length, 1);

    cleanup();
  });

  test("getAppVolumeByName finds a volume across apps by its Docker volume name", () => {
    const app = makeApp("app-twelve");

    appDatabase.createAppVolume({
      appId: app.id,
      volumeName: "app-twelve-data",
      containerPath: "/data",
      readOnly: false
    });

    const found = appDatabase.getAppVolumeByName("app-twelve-data");
    assert.equal(found?.appId, app.id);
    assert.equal(appDatabase.getAppVolumeByName("does-not-exist"), null);

    cleanup();
  });
});
