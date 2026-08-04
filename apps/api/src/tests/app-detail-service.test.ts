import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  buildAppDetail,
  formatDockerStatusText,
  type ContainerInspection
} from "../services/app-detail-service.js";
import { createAppDatabase, type StoredApp } from "../database.js";

function makeApp(overrides: Partial<StoredApp> = {}): StoredApp {
  return {
    id: 1,
    name: "sqlite-test",
    containerId: "stored-old-id",
    containerName: "app-sqlite-test",
    image: "nginx:alpine",
    containerPort: 80,
    domain: "sqlite-test.apps.hookstats.com",
    internalOnly: false,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastDeployedAt: "2026-01-02T00:00:00.000Z",
    environmentTouchedAt: null,
    memoryLimitMb: null,
    cpuLimit: null,
    deploymentRetention: null,
    ...overrides
  };
}

function makeInspection(
  overrides: Partial<ContainerInspection["state"]> = {}
): ContainerInspection {
  return {
    id: "live-container-id-1234567890",
    state: {
      running: true,
      status: "running",
      exitCode: 0,
      startedAt: "2026-01-02T00:00:01.000Z",
      finishedAt: "0001-01-01T00:00:00Z",
      ...overrides
    }
  };
}

describe("formatDockerStatusText", () => {
  test("describes a running container by its start time", () => {
    const text = formatDockerStatusText({
      running: true,
      status: "running",
      exitCode: 0,
      startedAt: "2026-01-02T00:00:01.000Z",
      finishedAt: "0001-01-01T00:00:00Z"
    });

    assert.equal(text, "Up since 2026-01-02T00:00:01.000Z");
  });

  test("describes an exited container by its exit code and time", () => {
    const text = formatDockerStatusText({
      running: false,
      status: "exited",
      exitCode: 137,
      startedAt: "2026-01-02T00:00:01.000Z",
      finishedAt: "2026-01-02T00:05:00.000Z"
    });

    assert.equal(text, "Exited (137) at 2026-01-02T00:05:00.000Z");
  });

  test("falls back to the raw status for other states", () => {
    const text = formatDockerStatusText({
      running: false,
      status: "created",
      exitCode: 0,
      startedAt: "0001-01-01T00:00:00Z",
      finishedAt: "0001-01-01T00:00:00Z"
    });

    assert.equal(text, "created");
  });
});

describe("buildAppDetail", () => {
  test("maps a stored app with a live container", () => {
    const detail = buildAppDetail(
      makeApp(),
      makeInspection(),
      true,
      "applied"
    );

    assert.equal(detail.id, 1);
    assert.equal(detail.name, "sqlite-test");
    assert.equal(detail.containerExists, true);
    assert.equal(detail.containerId, "live-container-id-1234567890");
    assert.equal(detail.shortContainerId, "live-contain");
    assert.equal(detail.dockerState, "running");
    assert.equal(
      detail.dockerStatusText,
      "Up since 2026-01-02T00:00:01.000Z"
    );
    assert.equal(detail.domain, "sqlite-test.apps.hookstats.com");
    assert.equal(detail.routingReady, true);
    assert.equal(detail.restartPolicy, "unless-stopped");
    assert.equal(detail.environmentStatus, "applied");
  });

  test("marks containerExists false and nulls Docker fields when the container is missing", () => {
    const detail = buildAppDetail(makeApp(), null, false, "pending");

    assert.equal(detail.containerExists, false);
    assert.equal(detail.dockerState, null);
    assert.equal(detail.dockerStatusText, null);

    // Falls back to the last known container ID from SQLite rather than
    // inventing one, since Docker never confirmed the container exists.
    assert.equal(detail.containerId, "stored-old-id");
    assert.equal(detail.shortContainerId, "stored-old-i");
    assert.equal(detail.routingReady, false);
    assert.equal(detail.environmentStatus, "pending");
  });

  test("prefers the live container ID over the stored one when both are present", () => {
    const detail = buildAppDetail(
      makeApp({ containerId: "stale-id" }),
      makeInspection({ running: false, status: "exited" }),
      true,
      "applied"
    );

    assert.equal(detail.containerId, "live-container-id-1234567890");
    assert.equal(detail.containerExists, true);
  });

  test("defaults imageUpdateAvailable to false when no status is passed", () => {
    const detail = buildAppDetail(makeApp(), makeInspection(), true, "applied");
    assert.equal(detail.imageUpdateAvailable, false);
    assert.equal(detail.imageUpdateCheckedAt, null);
  });

  test("surfaces a passed-in image update status", () => {
    const detail = buildAppDetail(makeApp(), makeInspection(), true, "applied", [], {
      updateAvailable: true,
      checkedAt: "2026-01-03T00:00:00.000Z"
    });
    assert.equal(detail.imageUpdateAvailable, true);
    assert.equal(detail.imageUpdateCheckedAt, "2026-01-03T00:00:00.000Z");
  });
});

describe("GET /apps/:id 404 condition", () => {
  test("getAppById returns null for a nonexistent id, which the route maps to 404", () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), "deployment-platform-test-")
    );
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    const appDatabase = createAppDatabase(dbPath);

    assert.equal(appDatabase.getAppById(999999), null);

    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
});