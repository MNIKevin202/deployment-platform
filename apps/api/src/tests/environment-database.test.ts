import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("environment variables (database layer)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-env-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
  });

  function cleanup() {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  test("creates and lists global variables", () => {
    appDatabase.createGlobalEnvVar({
      key: "TZ",
      value: "America/New_York",
      isSecret: false,
      enabled: true
    });

    const all = appDatabase.listGlobalEnvVars();
    assert.equal(all.length, 1);
    assert.equal(all[0].key, "TZ");
    assert.equal(all[0].value, "America/New_York");
    assert.equal(all[0].isSecret, false);
    assert.equal(all[0].enabled, true);

    cleanup();
  });

  test("rejects a duplicate global key", () => {
    appDatabase.createGlobalEnvVar({
      key: "TZ",
      value: "America/New_York",
      isSecret: false,
      enabled: true
    });

    assert.throws(() => {
      appDatabase.createGlobalEnvVar({
        key: "TZ",
        value: "UTC",
        isSecret: false,
        enabled: true
      });
    });

    cleanup();
  });

  test("updates a global variable's value, secret flag, and enabled state", () => {
    const created = appDatabase.createGlobalEnvVar({
      key: "NODE_ENV",
      value: "development",
      isSecret: false,
      enabled: true
    });

    appDatabase.updateGlobalEnvVar(created.id, {
      value: "production",
      enabled: false
    });

    const updated = appDatabase.getGlobalEnvVarById(created.id);
    assert.equal(updated?.value, "production");
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.isSecret, false);

    cleanup();
  });

  test("deletes a global variable", () => {
    const created = appDatabase.createGlobalEnvVar({
      key: "TZ",
      value: "UTC",
      isSecret: false,
      enabled: true
    });

    appDatabase.deleteGlobalEnvVar(created.id);
    assert.equal(appDatabase.getGlobalEnvVarById(created.id), null);

    cleanup();
  });

  test("creates and lists app-scoped variables, rejects duplicate key per app", () => {
    const app = appDatabase.createApp({
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-one"
    });

    appDatabase.createAppEnvVar({
      appId: app.id,
      key: "PORT",
      value: "3000",
      isSecret: false,
      enabled: true
    });

    assert.equal(appDatabase.listAppEnvVars(app.id).length, 1);

    assert.throws(() => {
      appDatabase.createAppEnvVar({
        appId: app.id,
        key: "PORT",
        value: "4000",
        isSecret: false,
        enabled: true
      });
    });

    cleanup();
  });

  test("allows the same key across two different apps", () => {
    const appOne = appDatabase.createApp({
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-one"
    });

    const appTwo = appDatabase.createApp({
      name: "app-two",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-two"
    });

    appDatabase.createAppEnvVar({
      appId: appOne.id,
      key: "PORT",
      value: "3000",
      isSecret: false,
      enabled: true
    });

    appDatabase.createAppEnvVar({
      appId: appTwo.id,
      key: "PORT",
      value: "4000",
      isSecret: false,
      enabled: true
    });

    assert.equal(appDatabase.listAppEnvVars(appOne.id)[0].value, "3000");
    assert.equal(appDatabase.listAppEnvVars(appTwo.id)[0].value, "4000");

    cleanup();
  });

  test("keeps app variables scoped — one app's variables never leak into another's list", () => {
    const appOne = appDatabase.createApp({
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-one"
    });

    const appTwo = appDatabase.createApp({
      name: "app-two",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-two"
    });

    appDatabase.createAppEnvVar({
      appId: appOne.id,
      key: "SECRET_ONE",
      value: "a",
      isSecret: false,
      enabled: true
    });

    assert.equal(appDatabase.listAppEnvVars(appTwo.id).length, 0);
    assert.equal(appDatabase.listAppEnvVars(appOne.id).length, 1);

    cleanup();
  });

  test("cascades app-variable deletion when the owning app is deleted", () => {
    const app = appDatabase.createApp({
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-one"
    });

    const variable = appDatabase.createAppEnvVar({
      appId: app.id,
      key: "PORT",
      value: "3000",
      isSecret: false,
      enabled: true
    });

    appDatabase.deleteApp(app.id);

    assert.equal(appDatabase.getAppEnvVarById(variable.id), null);
    assert.equal(appDatabase.listAppEnvVars(app.id).length, 0);

    cleanup();
  });

  test("touchAppEnvironment and touchAllAppsEnvironment set environment_touched_at", () => {
    const app = appDatabase.createApp({
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-one"
    });

    assert.equal(appDatabase.getAppById(app.id)?.environmentTouchedAt, null);

    appDatabase.touchAppEnvironment(app.id);
    assert.notEqual(
      appDatabase.getAppById(app.id)?.environmentTouchedAt,
      null
    );

    const appTwo = appDatabase.createApp({
      name: "app-two",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-two"
    });

    appDatabase.touchAllAppsEnvironment();
    assert.notEqual(
      appDatabase.getAppById(appTwo.id)?.environmentTouchedAt,
      null
    );

    cleanup();
  });
});
