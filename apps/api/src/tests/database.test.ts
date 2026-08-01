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

    assert.equal(rows.length, 22);
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].name, "initial_schema");
    assert.equal(rows[1].version, 2);
    assert.equal(rows[1].name, "expand_apps_columns");
    assert.equal(rows[2].version, 3);
    assert.equal(rows[2].name, "environment_variables");
    assert.equal(rows[3].version, 4);
    assert.equal(rows[3].name, "app_volumes");
    assert.equal(rows[4].version, 5);
    assert.equal(rows[4].name, "app_health_checks");
    assert.equal(rows[5].version, 6);
    assert.equal(rows[5].name, "app_deployment_events");
    assert.equal(rows[6].version, 7);
    assert.equal(rows[6].name, "provider_credentials");
    assert.equal(rows[7].version, 8);
    assert.equal(rows[7].name, "app_sources");
    assert.equal(rows[8].version, 9);
    assert.equal(rows[8].name, "app_source_deployment_metadata");
    assert.equal(rows[9].version, 10);
    assert.equal(rows[9].name, "source_port_metadata");
    assert.equal(rows[10].version, 11);
    assert.equal(rows[10].name, "performance_diagnostics");
    assert.equal(rows[11].version, 12);
    assert.equal(rows[11].name, "idempotency_keys");
    assert.equal(rows[12].version, 13);
    assert.equal(rows[12].name, "internal_only_apps");
    assert.equal(rows[13].version, 14);
    assert.equal(rows[13].name, "github_app_installations");
    assert.equal(rows[14].version, 15);
    assert.equal(rows[14].name, "source_selected_strategy");
    assert.equal(rows[15].version, 16);
    assert.equal(rows[15].name, "app_deployments");
    assert.equal(rows[16].version, 17);
    assert.equal(rows[16].name, "build_logs");
    assert.equal(rows[17].version, 18);
    assert.equal(rows[17].name, "platform_settings");
    assert.equal(rows[18].version, 19);
    assert.equal(rows[18].name, "app_resource_limits");
    assert.equal(rows[19].version, 20);
    assert.equal(rows[19].name, "app_published_ports");
    assert.equal(rows[20].version, 21);
    assert.equal(rows[20].name, "cron_jobs");
    assert.equal(rows[21].version, 22);
    assert.equal(rows[21].name, "cron_job_runs");

    cleanup();
  });

  test("migrations are idempotent across reopen", () => {
    appDatabase.close();

    const reopened = createAppDatabase(dbPath);

    const rows = reopened.db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];

    assert.equal(rows.length, 22);
    assert.equal(rows[rows.length - 1].version, 22);
    assert.equal(rows[rows.length - 1].name, "cron_job_runs");

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
