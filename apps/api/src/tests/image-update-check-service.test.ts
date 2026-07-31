import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createImageUpdateChecker,
  type ImageUpdateCheckApp,
  type ImageUpdateCheckDockerOps
} from "../services/image-update-check-service.js";

const silentLogger = { error: () => {} };

function fakeDockerOps(overrides: Partial<ImageUpdateCheckDockerOps> = {}): ImageUpdateCheckDockerOps {
  return {
    inspectContainerImageId: async () => "sha256:running",
    pullImage: async () => {},
    inspectImageId: async () => "sha256:running",
    ...overrides
  };
}

describe("createImageUpdateChecker", () => {
  test("marks an app as up to date when the pulled image matches the running one", async () => {
    const apps: ImageUpdateCheckApp[] = [{ id: 1, containerId: "c1", image: "postgres:16" }];
    const checker = createImageUpdateChecker({
      listCandidateApps: () => apps,
      hasAppSource: () => false,
      dockerOps: fakeDockerOps(),
      logger: silentLogger,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    await checker.runOnce();

    assert.deepEqual(checker.getStatus(1), {
      updateAvailable: false,
      checkedAt: "2026-01-01T00:00:00.000Z"
    });
  });

  test("marks an app as update-available when the pulled image differs from the running one", async () => {
    const apps: ImageUpdateCheckApp[] = [{ id: 1, containerId: "c1", image: "postgres:16" }];
    const checker = createImageUpdateChecker({
      listCandidateApps: () => apps,
      hasAppSource: () => false,
      dockerOps: fakeDockerOps({
        inspectContainerImageId: async () => "sha256:old",
        inspectImageId: async () => "sha256:new"
      }),
      logger: silentLogger
    });

    await checker.runOnce();

    assert.equal(checker.getStatus(1)?.updateAvailable, true);
  });

  test("skips apps that have a GitHub app_sources row", async () => {
    const apps: ImageUpdateCheckApp[] = [{ id: 1, containerId: "c1", image: "myrepo:latest" }];
    let pullCalled = false;
    const checker = createImageUpdateChecker({
      listCandidateApps: () => apps,
      hasAppSource: () => true,
      dockerOps: fakeDockerOps({
        pullImage: async () => {
          pullCalled = true;
        }
      }),
      logger: silentLogger
    });

    await checker.runOnce();

    assert.equal(pullCalled, false);
    assert.equal(checker.getStatus(1), null);
  });

  test("skips apps with no running container", async () => {
    const apps: ImageUpdateCheckApp[] = [{ id: 1, containerId: null, image: "postgres:16" }];
    const checker = createImageUpdateChecker({
      listCandidateApps: () => apps,
      hasAppSource: () => false,
      dockerOps: fakeDockerOps(),
      logger: silentLogger
    });

    await checker.runOnce();

    assert.equal(checker.getStatus(1), null);
  });

  test("a pull failure for one app is logged and doesn't affect others", async () => {
    const apps: ImageUpdateCheckApp[] = [
      { id: 1, containerId: "c1", image: "broken:latest" },
      { id: 2, containerId: "c2", image: "postgres:16" }
    ];
    const errors: unknown[] = [];
    const checker = createImageUpdateChecker({
      listCandidateApps: () => apps,
      hasAppSource: () => false,
      dockerOps: fakeDockerOps({
        pullImage: async (image) => {
          if (image === "broken:latest") {
            throw new Error("no such image");
          }
        }
      }),
      logger: { error: (obj) => errors.push(obj) }
    });

    await checker.runOnce();

    assert.equal(checker.getStatus(1), null);
    assert.equal(checker.getStatus(2)?.updateAvailable, false);
    assert.equal(errors.length, 1);
  });

  test("an overlapping tick is skipped while one is already in flight", async () => {
    const apps: ImageUpdateCheckApp[] = [{ id: 1, containerId: "c1", image: "postgres:16" }];
    let concurrentCalls = 0;
    let maxConcurrent = 0;

    const checker = createImageUpdateChecker({
      listCandidateApps: () => apps,
      hasAppSource: () => false,
      dockerOps: fakeDockerOps({
        pullImage: async () => {
          concurrentCalls += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrentCalls -= 1;
        }
      }),
      logger: silentLogger
    });

    await Promise.all([checker.runOnce(), checker.runOnce()]);

    assert.equal(maxConcurrent, 1);
  });
});
