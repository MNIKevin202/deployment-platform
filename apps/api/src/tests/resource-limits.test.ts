import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { buildResourceHostConfig } from "../services/resource-limits.js";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("buildResourceHostConfig", () => {
  test("omits everything when there are no limits", () => {
    assert.deepEqual(buildResourceHostConfig({ memoryLimitMb: null, cpuLimit: null }), {});
    assert.deepEqual(buildResourceHostConfig({ memoryLimitMb: 0, cpuLimit: 0 }), {});
  });

  test("maps memory to a hard cap (Memory == MemorySwap) in bytes", () => {
    const config = buildResourceHostConfig({ memoryLimitMb: 512, cpuLimit: null });
    assert.equal(config.Memory, 512 * 1024 * 1024);
    assert.equal(config.MemorySwap, 512 * 1024 * 1024);
    assert.equal(config.NanoCpus, undefined);
  });

  test("maps cpu cores to NanoCpus", () => {
    assert.equal(buildResourceHostConfig({ memoryLimitMb: null, cpuLimit: 0.5 }).NanoCpus, 500_000_000);
    assert.equal(buildResourceHostConfig({ memoryLimitMb: null, cpuLimit: 2 }).NanoCpus, 2_000_000_000);
  });
});

describe("resource limits in the apps table", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dp-resources-db-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("createApp stores limits and updateAppResources changes them", () => {
    const app = appDatabase.createApp({
      name: "web",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-web",
      memoryLimitMb: 256,
      cpuLimit: 1
    });
    assert.equal(app.memoryLimitMb, 256);
    assert.equal(app.cpuLimit, 1);

    appDatabase.updateAppResources(app.id, { memoryLimitMb: null, cpuLimit: 0.5 });
    const updated = appDatabase.getAppById(app.id);
    assert.equal(updated?.memoryLimitMb, null);
    assert.equal(updated?.cpuLimit, 0.5);
  });

  test("limits default to null when omitted", () => {
    const app = appDatabase.createApp({
      name: "db",
      image: "postgres:16",
      containerPort: 5432,
      containerName: "app-db"
    });
    assert.equal(app.memoryLimitMb, null);
    assert.equal(app.cpuLimit, null);
  });
});
