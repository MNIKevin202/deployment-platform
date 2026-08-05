import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getDockerUsageSnapshot, getHostDiskUsage, type DockerUsageOps } from "../services/docker-usage-service.js";

describe("getDockerUsageSnapshot", () => {
  test("reports raw counts and LayersSize as the images size", async () => {
    const fakeDocker: DockerUsageOps = {
      listImages: async () => [{}, {}, {}],
      listContainers: async () => [{}, {}, {}, {}, {}],
      listVolumes: async () => ({ Volumes: [{}, {}] }),
      df: async () => ({ LayersSize: 123_456 })
    };

    const snapshot = await getDockerUsageSnapshot(fakeDocker as never);
    assert.deepEqual(snapshot, {
      images: 3,
      containers: 5,
      volumes: 2,
      imagesSizeBytes: 123_456
    });
  });

  test("degrades gracefully when df or volumes come back empty/missing", async () => {
    const fakeDocker: DockerUsageOps = {
      listImages: async () => [],
      listContainers: async () => [],
      listVolumes: async () => ({ Volumes: null }),
      df: async () => ({})
    };

    const snapshot = await getDockerUsageSnapshot(fakeDocker as never);
    assert.deepEqual(snapshot, { images: 0, containers: 0, volumes: 0, imagesSizeBytes: 0 });
  });
});

describe("getHostDiskUsage", () => {
  test("computes used bytes as total minus available (not free)", async () => {
    const usage = await getHostDiskUsage("/", async () => ({
      blocks: 1000,
      bsize: 1024,
      bavail: 400
    }));

    assert.equal(usage.totalBytes, 1000 * 1024);
    assert.equal(usage.usedBytes, (1000 - 400) * 1024);
  });

  test("never returns a negative used value", async () => {
    // Pathological/rounding input: available slightly exceeds total.
    const usage = await getHostDiskUsage("/", async () => ({
      blocks: 100,
      bsize: 1024,
      bavail: 200
    }));

    assert.equal(usage.usedBytes, 0);
  });
});
