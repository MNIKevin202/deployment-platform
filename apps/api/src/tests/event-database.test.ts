import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("deployment events (database layer)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-event-db-test-"));
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

  test("creates an event and loads it back with all fields", () => {
    const app = makeApp("app-one");

    const created = appDatabase.createDeploymentEvent({
      appId: app.id,
      eventType: "app-created",
      severity: "info",
      message: "App created",
      metadataJson: JSON.stringify({ image: "nginx:alpine" })
    });

    assert.equal(created.appId, app.id);
    assert.equal(created.eventType, "app-created");
    assert.equal(created.severity, "info");
    assert.equal(created.message, "App created");
    assert.equal(created.metadataJson, JSON.stringify({ image: "nginx:alpine" }));
    assert.ok(created.id > 0);
    assert.ok(created.createdAt);

    cleanup();
  });

  test("lists events newest-first", () => {
    const app = makeApp("app-two");

    const first = appDatabase.createDeploymentEvent({
      appId: app.id,
      eventType: "app-created",
      severity: "info",
      message: "first",
      metadataJson: null
    });

    const second = appDatabase.createDeploymentEvent({
      appId: app.id,
      eventType: "redeploy-started",
      severity: "info",
      message: "second",
      metadataJson: null
    });

    const third = appDatabase.createDeploymentEvent({
      appId: app.id,
      eventType: "redeploy-succeeded",
      severity: "info",
      message: "third",
      metadataJson: null
    });

    const events = appDatabase.listDeploymentEvents(app.id, { limit: 10 });

    assert.deepEqual(
      events.map((e) => e.id),
      [third.id, second.id, first.id]
    );

    cleanup();
  });

  test("respects the limit", () => {
    const app = makeApp("app-three");

    for (let i = 0; i < 5; i += 1) {
      appDatabase.createDeploymentEvent({
        appId: app.id,
        eventType: "app-created",
        severity: "info",
        message: `event ${i}`,
        metadataJson: null
      });
    }

    const events = appDatabase.listDeploymentEvents(app.id, { limit: 2 });
    assert.equal(events.length, 2);

    cleanup();
  });

  test("paginates with beforeId, returning strictly older events", () => {
    const app = makeApp("app-four");

    const ids: number[] = [];

    for (let i = 0; i < 5; i += 1) {
      const event = appDatabase.createDeploymentEvent({
        appId: app.id,
        eventType: "app-created",
        severity: "info",
        message: `event ${i}`,
        metadataJson: null
      });
      ids.push(event.id);
    }

    const firstPage = appDatabase.listDeploymentEvents(app.id, { limit: 2 });
    assert.deepEqual(firstPage.map((e) => e.id), [ids[4], ids[3]]);

    const secondPage = appDatabase.listDeploymentEvents(app.id, {
      limit: 2,
      beforeId: firstPage[firstPage.length - 1].id
    });
    assert.deepEqual(secondPage.map((e) => e.id), [ids[2], ids[1]]);

    cleanup();
  });

  test("keeps events scoped to their own app", () => {
    const appOne = makeApp("app-five");
    const appTwo = makeApp("app-six");

    appDatabase.createDeploymentEvent({
      appId: appOne.id,
      eventType: "app-created",
      severity: "info",
      message: "for app one",
      metadataJson: null
    });

    assert.equal(appDatabase.listDeploymentEvents(appTwo.id, { limit: 10 }).length, 0);
    assert.equal(appDatabase.listDeploymentEvents(appOne.id, { limit: 10 }).length, 1);

    cleanup();
  });

  test("cascades event deletion when the owning app is deleted", () => {
    const app = makeApp("app-seven");

    appDatabase.createDeploymentEvent({
      appId: app.id,
      eventType: "app-created",
      severity: "info",
      message: "will be cascaded away",
      metadataJson: null
    });

    appDatabase.deleteApp(app.id);

    // Can't list by the now-deleted app id in any meaningful way, but the
    // underlying row must be gone — verified indirectly via the raw db.
    const remaining = appDatabase.db
      .prepare("SELECT COUNT(*) AS count FROM app_deployment_events WHERE app_id = ?")
      .get(app.id) as { count: number };

    assert.equal(remaining.count, 0);

    cleanup();
  });
});
