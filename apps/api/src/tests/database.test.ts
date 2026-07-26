import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("appDatabase", () => {
  let tempDir: string;
  let dbPath: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-test-"));
    dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
  });

  after(() => {
    // no-op: cleanup handled per-test below
  });

  function cleanup() {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  test("runs migrations and records applied versions", () => {
    const rows = appDatabase.db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];

    assert.equal(rows.length, 2);
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].name, "initial_schema");
    assert.equal(rows[1].version, 2);
    assert.equal(rows[1].name, "expand_apps_columns");

    cleanup();
  });

  test("migrations are idempotent across reopen", () => {
    appDatabase.close();

    const reopened = createAppDatabase(dbPath);

    const rows = reopened.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];

    assert.equal(rows.length, 2);

    reopened.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("createApp applies defaults and round-trips through getAppByName", () => {
    const created = appDatabase.createApp({
      name: "hello-nginx",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-hello-nginx"
    });

    assert.equal(created.name, "hello-nginx");
    assert.equal(created.status, "created");
    assert.equal(created.desiredStatus, "running");
    assert.equal(created.restartPolicy, "unless-stopped");
    assert.equal(created.domain, null);
    assert.equal(created.containerId, null);
    assert.equal(created.lastDeployedAt, null);

    const fetched = appDatabase.getAppByName("hello-nginx");
    assert.deepEqual(fetched, created);

    const fetchedById = appDatabase.getAppById(created.id);
    assert.deepEqual(fetchedById, created);

    cleanup();
  });

  test("createApp rejects duplicate names", () => {
    appDatabase.createApp({
      name: "dup-app",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-dup-app"
    });

    assert.throws(() => {
      appDatabase.createApp({
        name: "dup-app",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-dup-app"
      });
    });

    cleanup();
  });

  test("updateAppDomain rejects duplicate domains", () => {
    const first = appDatabase.createApp({
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-one"
    });

    const second = appDatabase.createApp({
      name: "app-two",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-two"
    });

    appDatabase.updateAppDomain(first.id, "app-one.apps.hookstats.com");

    assert.throws(() => {
      appDatabase.updateAppDomain(second.id, "app-one.apps.hookstats.com");
    });

    cleanup();
  });

  test("updateAppContainer sets containerId, status, and lastDeployedAt", () => {
    const created = appDatabase.createApp({
      name: "app-three",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-three"
    });

    appDatabase.updateAppContainer(created.id, {
      containerId: "abc123",
      status: "running"
    });

    const updated = appDatabase.getAppById(created.id);
    assert.equal(updated?.containerId, "abc123");
    assert.equal(updated?.status, "running");
    assert.notEqual(updated?.lastDeployedAt, null);

    cleanup();
  });

  test("updateAppStatus, updateAppDesiredStatus, and updateAppImage update fields", () => {
    const created = appDatabase.createApp({
      name: "app-four",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-four"
    });

    appDatabase.updateAppStatus(created.id, "exited");
    appDatabase.updateAppDesiredStatus(created.id, "stopped");
    appDatabase.updateAppImage(created.id, "nginx:latest");

    const updated = appDatabase.getAppById(created.id);
    assert.equal(updated?.status, "exited");
    assert.equal(updated?.desiredStatus, "stopped");
    assert.equal(updated?.image, "nginx:latest");

    cleanup();
  });

  test("getAppByDomain finds the matching app", () => {
    const created = appDatabase.createApp({
      name: "app-five",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-five"
    });

    appDatabase.updateAppDomain(created.id, "app-five.apps.hookstats.com");

    const found = appDatabase.getAppByDomain("app-five.apps.hookstats.com");
    assert.equal(found?.id, created.id);

    assert.equal(appDatabase.getAppByDomain("missing.apps.hookstats.com"), null);

    cleanup();
  });

  test("listApps returns all apps, deleteApp removes one", () => {
    appDatabase.createApp({
      name: "app-six",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-six"
    });

    const second = appDatabase.createApp({
      name: "app-seven",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-app-seven"
    });

    assert.equal(appDatabase.listApps().length, 2);

    appDatabase.deleteApp(second.id);

    const remaining = appDatabase.listApps();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].name, "app-six");

    cleanup();
  });

  test("healthCheck returns true for a usable database", () => {
    assert.equal(appDatabase.healthCheck(), true);
    cleanup();
  });
});
