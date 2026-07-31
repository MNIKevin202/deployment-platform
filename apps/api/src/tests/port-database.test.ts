import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("app published ports (database layer)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-port-test-"));
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
      image: "itzg/minecraft-server",
      containerPort: 25565,
      containerName: `app-${name}`
    });
  }

  test("creates and lists published ports for an app", () => {
    const app = makeApp("mc");

    const created = appDatabase.createAppPublishedPort({
      appId: app.id,
      hostPort: 25565,
      containerPort: 25565,
      protocol: "tcp"
    });

    assert.equal(created.appId, app.id);
    assert.equal(created.hostPort, 25565);
    assert.equal(created.protocol, "tcp");

    const all = appDatabase.listAppPublishedPorts(app.id);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], created);

    cleanup();
  });

  test("getAppPublishedPortByHost finds the owning app, distinguishing protocol", () => {
    const app = makeApp("bedrock");
    appDatabase.createAppPublishedPort({
      appId: app.id,
      hostPort: 19132,
      containerPort: 19132,
      protocol: "udp"
    });

    assert.equal(appDatabase.getAppPublishedPortByHost(19132, "udp")?.appId, app.id);
    // Same number, different protocol is a distinct binding.
    assert.equal(appDatabase.getAppPublishedPortByHost(19132, "tcp"), null);

    cleanup();
  });

  test("rejects the same host port/protocol across two apps (global uniqueness)", () => {
    const first = makeApp("first");
    const second = makeApp("second");

    appDatabase.createAppPublishedPort({
      appId: first.id,
      hostPort: 25565,
      containerPort: 25565,
      protocol: "tcp"
    });

    assert.throws(() =>
      appDatabase.createAppPublishedPort({
        appId: second.id,
        hostPort: 25565,
        containerPort: 25565,
        protocol: "tcp"
      })
    );

    cleanup();
  });

  test("cascades port-record deletion when the owning app is deleted", () => {
    const app = makeApp("temp");
    appDatabase.createAppPublishedPort({
      appId: app.id,
      hostPort: 25565,
      containerPort: 25565,
      protocol: "tcp"
    });

    appDatabase.deleteApp(app.id);

    // The host port is free again for a future app.
    assert.equal(appDatabase.getAppPublishedPortByHost(25565, "tcp"), null);

    cleanup();
  });
});
