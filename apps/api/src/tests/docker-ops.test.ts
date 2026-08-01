import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type Docker from "dockerode";
import { createDockerOps } from "../services/redeploy-service.js";
import { isRecoverableBuildCacheError } from "../services/github-deploy-docker-ops.js";

describe("isRecoverableBuildCacheError", () => {
  test("matches the corrupt-snapshot failures that a no-cache rebuild fixes", () => {
    for (const message of [
      "NotFound: parent snapshot sha256:37d1b91b does not exist: not found",
      "failed to prepare … : parent snapshot sha256:abc does not exist",
      "failed to prepare extraction snapshot \"extract-123\": parent does not exist",
      "snapshot sha256:deadbeef does not exist: not found"
    ]) {
      assert.equal(isRecoverableBuildCacheError(message), true, message);
    }
  });

  test("does NOT match a genuine build error, so a real failure is never retried", () => {
    for (const message of [
      "The command '/bin/sh -c npm run build' returned a non-zero code: 1",
      "failed to solve: process \"/bin/sh -c tsc\" did not complete successfully: exit code: 2",
      "COPY failed: file not found in build context",
      "pull access denied for private/image, repository does not exist",
      "manifest for node:99-alpine not found"
    ]) {
      assert.equal(isRecoverableBuildCacheError(message), false, message);
    }
  });

  test("is case-insensitive", () => {
    assert.equal(
      isRecoverableBuildCacheError("NotFound: PARENT SNAPSHOT sha256:x DOES NOT EXIST"),
      true
    );
  });
});

interface FakeVolumeInspect {
  Labels?: Record<string, string> | null;
}

function makeFakeDocker(existingVolume: FakeVolumeInspect | null): {
  docker: Docker;
  createVolumeCalls: Array<{ Name: string; Labels?: Record<string, string> }>;
} {
  const createVolumeCalls: Array<{
    Name: string;
    Labels?: Record<string, string>;
  }> = [];

  const fakeDocker = {
    getVolume(_name: string) {
      return {
        async inspect() {
          if (!existingVolume) {
            const error = new Error("no such volume") as Error & {
              statusCode?: number;
            };
            error.statusCode = 404;
            throw error;
          }

          return existingVolume;
        }
      };
    },
    async createVolume(opts: { Name: string; Labels?: Record<string, string> }) {
      createVolumeCalls.push(opts);
      return {};
    }
  };

  return { docker: fakeDocker as unknown as Docker, createVolumeCalls };
}

describe("createDockerOps().ensureVolume", () => {
  test("creates a labeled volume when none exists yet", async () => {
    const { docker, createVolumeCalls } = makeFakeDocker(null);
    const ops = createDockerOps(docker);

    await ops.ensureVolume("app-one-data", "app-one");

    assert.equal(createVolumeCalls.length, 1);
    assert.equal(createVolumeCalls[0].Name, "app-one-data");
    assert.equal(
      createVolumeCalls[0].Labels?.["com.deployment-platform.app-name"],
      "app-one"
    );
    assert.equal(
      createVolumeCalls[0].Labels?.["com.deployment-platform.managed"],
      "true"
    );
  });

  test("is a no-op when the volume already exists and is owned by this app", async () => {
    const { docker, createVolumeCalls } = makeFakeDocker({
      Labels: { "com.deployment-platform.app-name": "app-one" }
    });
    const ops = createDockerOps(docker);

    await ops.ensureVolume("app-one-data", "app-one");

    assert.equal(createVolumeCalls.length, 0);
  });

  test("throws rather than reusing a volume owned by a different app", async () => {
    const { docker, createVolumeCalls } = makeFakeDocker({
      Labels: { "com.deployment-platform.app-name": "someone-else" }
    });
    const ops = createDockerOps(docker);

    await assert.rejects(
      () => ops.ensureVolume("shared-name", "app-one"),
      /not owned by this app/
    );

    assert.equal(createVolumeCalls.length, 0);
  });

  test("throws rather than reusing an unmanaged volume with no ownership label (e.g. a platform-owned volume)", async () => {
    const { docker, createVolumeCalls } = makeFakeDocker({ Labels: {} });
    const ops = createDockerOps(docker);

    await assert.rejects(
      () => ops.ensureVolume("preexisting-volume", "app-one"),
      /not owned by this app/
    );

    assert.equal(createVolumeCalls.length, 0);
  });
});
