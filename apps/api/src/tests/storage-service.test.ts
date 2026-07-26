import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildDefaultVolumeName,
  buildVolumeMounts,
  isReservedVolumeName
} from "../services/storage-service.js";
import type { StoredAppVolume } from "../volume-database.js";

function makeVolume(overrides: Partial<StoredAppVolume> = {}): StoredAppVolume {
  return {
    id: 1,
    appId: 1,
    volumeName: "sqlite-test-data",
    containerPath: "/data",
    readOnly: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("buildDefaultVolumeName", () => {
  test("combines app name and a sanitized path segment", () => {
    assert.equal(buildDefaultVolumeName("sqlite-test", "/data"), "sqlite-test-data");
  });

  test("collapses nested paths into hyphen-separated segments", () => {
    assert.equal(
      buildDefaultVolumeName("myapp", "/app/storage"),
      "myapp-app-storage"
    );
  });

  test("falls back to 'data' for the root path", () => {
    assert.equal(buildDefaultVolumeName("myapp", "/"), "myapp-data");
  });

  test("strips characters that are not lowercase letters or digits from the path", () => {
    assert.equal(
      buildDefaultVolumeName("myapp", "/Data_2!"),
      "myapp-data-2"
    );
  });

  test("truncates very long generated names", () => {
    const longPath = `/${"segment".repeat(20)}`;
    const name = buildDefaultVolumeName("myapp", longPath);
    assert.ok(name.length <= 60);
  });
});

describe("isReservedVolumeName", () => {
  test("rejects exact platform volume names", () => {
    assert.equal(isReservedVolumeName("deployment-platform-api-data"), true);
    assert.equal(isReservedVolumeName("deployment-platform-caddy-data"), true);
    assert.equal(
      isReservedVolumeName("deployment-platform-caddy-config"),
      true
    );
  });

  test("rejects anything under the platform's reserved prefix", () => {
    assert.equal(isReservedVolumeName("deployment-platform-anything"), true);
  });

  test("allows ordinary app volume names", () => {
    assert.equal(isReservedVolumeName("sqlite-test-data"), false);
    assert.equal(isReservedVolumeName("my-app-storage"), false);
  });
});

describe("buildVolumeMounts", () => {
  test("maps stored volumes to structured Docker volume mounts", () => {
    const mounts = buildVolumeMounts([
      makeVolume({ volumeName: "a-data", containerPath: "/data", readOnly: false }),
      makeVolume({ volumeName: "a-config", containerPath: "/config", readOnly: true })
    ]);

    assert.deepEqual(mounts, [
      { Type: "volume", Source: "a-data", Target: "/data", ReadOnly: false },
      { Type: "volume", Source: "a-config", Target: "/config", ReadOnly: true }
    ]);
  });

  test("every mount is Type: volume — never a host bind mount", () => {
    const mounts = buildVolumeMounts([makeVolume()]);
    assert.ok(mounts.every((mount) => mount.Type === "volume"));
  });

  test("returns an empty array for no volumes", () => {
    assert.deepEqual(buildVolumeMounts([]), []);
  });
});
