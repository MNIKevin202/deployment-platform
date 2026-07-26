import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type Docker from "dockerode";
import { createDockerOps } from "../services/redeploy-service.js";

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
