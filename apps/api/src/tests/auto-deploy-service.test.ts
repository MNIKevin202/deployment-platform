import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAutoDeployScheduler } from "../services/auto-deploy-service.js";
import type { AppDatabase, AutoDeployCandidate } from "../database.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function candidate(overrides: Partial<AutoDeployCandidate> = {}): AutoDeployCandidate {
  return {
    appId: 1,
    repositoryOwner: "octocat",
    repositoryName: "hello-world",
    branch: "main",
    latestDeployedCommitSha: "old-sha",
    deploymentMode: "dockerfile",
    ...overrides
  };
}

interface FakeDbOptions {
  candidates: AutoDeployCandidate[];
  locked?: Set<number>;
}

function fakeDb(options: FakeDbOptions): AppDatabase {
  return {
    listAutoDeploySources: () => options.candidates,
    isDeploymentLocked: (appId: number) => options.locked?.has(appId) ?? false
  } as unknown as AppDatabase;
}

describe("createAutoDeployScheduler", () => {
  test("deploys when the branch head differs from the last deployed commit", async () => {
    const deployed: number[] = [];
    const scheduler = createAutoDeployScheduler({
      appDatabase: fakeDb({ candidates: [candidate({ appId: 7, latestDeployedCommitSha: "old" })] }),
      resolveBranchHead: async () => "new",
      triggerDeploy: async (appId) => {
        deployed.push(appId);
      },
      logger: silentLogger
    });

    await scheduler.runOnce();
    assert.deepEqual(deployed, [7]);
  });

  test("does nothing when the head equals the last deployed commit", async () => {
    const deployed: number[] = [];
    const scheduler = createAutoDeployScheduler({
      appDatabase: fakeDb({ candidates: [candidate({ latestDeployedCommitSha: "same" })] }),
      resolveBranchHead: async () => "same",
      triggerDeploy: async (appId) => {
        deployed.push(appId);
      },
      logger: silentLogger
    });

    await scheduler.runOnce();
    assert.deepEqual(deployed, []);
  });

  test("skips an app that is already deployment-locked", async () => {
    const deployed: number[] = [];
    const scheduler = createAutoDeployScheduler({
      appDatabase: fakeDb({ candidates: [candidate({ appId: 3 })], locked: new Set([3]) }),
      resolveBranchHead: async () => "new",
      triggerDeploy: async (appId) => {
        deployed.push(appId);
      },
      logger: silentLogger
    });

    await scheduler.runOnce();
    assert.deepEqual(deployed, []);
  });

  test("skips a candidate whose repository is not resolved", async () => {
    let resolveCalls = 0;
    const scheduler = createAutoDeployScheduler({
      appDatabase: fakeDb({ candidates: [candidate({ repositoryOwner: null, repositoryName: null })] }),
      resolveBranchHead: async () => {
        resolveCalls += 1;
        return "new";
      },
      triggerDeploy: async () => {},
      logger: silentLogger
    });

    await scheduler.runOnce();
    assert.equal(resolveCalls, 0);
  });

  test("first-time deploy: null last-deployed commit but a real head", async () => {
    const deployed: number[] = [];
    const scheduler = createAutoDeployScheduler({
      appDatabase: fakeDb({ candidates: [candidate({ appId: 9, latestDeployedCommitSha: null })] }),
      resolveBranchHead: async () => "first",
      triggerDeploy: async (appId) => {
        deployed.push(appId);
      },
      logger: silentLogger
    });

    await scheduler.runOnce();
    assert.deepEqual(deployed, [9]);
  });

  test("a failing head resolution for one app doesn't block the others", async () => {
    const deployed: number[] = [];
    const scheduler = createAutoDeployScheduler({
      appDatabase: fakeDb({
        candidates: [
          candidate({ appId: 1, repositoryName: "boom" }),
          candidate({ appId: 2, repositoryName: "ok" })
        ]
      }),
      resolveBranchHead: async (c) => {
        if (c.repositoryName === "boom") {
          throw new Error("github exploded");
        }
        return "new";
      },
      triggerDeploy: async (appId) => {
        deployed.push(appId);
      },
      logger: silentLogger
    });

    await scheduler.runOnce();
    assert.deepEqual(deployed, [2]);
  });
});
