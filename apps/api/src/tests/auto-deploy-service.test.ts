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
        return true;
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
        return true;
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
        return true;
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
      triggerDeploy: async () => true,
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
        return true;
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
        return true;
      },
      logger: silentLogger
    });

    await scheduler.runOnce();
    assert.deepEqual(deployed, [2]);
  });

  test("circuit breaker: stops retrying a commit after N consecutive failures", async () => {
    let attempts = 0;
    const scheduler = createAutoDeployScheduler({
      appDatabase: fakeDb({ candidates: [candidate({ appId: 5, latestDeployedCommitSha: "old" })] }),
      resolveBranchHead: async () => "broken-commit",
      // Deploy always fails — deployed-commit never advances, so the naive
      // scheduler would re-attempt every tick forever.
      triggerDeploy: async () => {
        attempts += 1;
        return false;
      },
      maxConsecutiveFailures: 3,
      logger: silentLogger
    });

    for (let tick = 0; tick < 6; tick += 1) {
      await scheduler.runOnce();
    }

    assert.equal(attempts, 3, "it tries three times, then the breaker opens");
  });

  test("circuit breaker: a NEW commit resets the breaker and gets fresh attempts", async () => {
    let head = "commit-a";
    let attempts = 0;
    const scheduler = createAutoDeployScheduler({
      appDatabase: fakeDb({ candidates: [candidate({ appId: 6, latestDeployedCommitSha: "old" })] }),
      resolveBranchHead: async () => head,
      triggerDeploy: async () => {
        attempts += 1;
        return false;
      },
      maxConsecutiveFailures: 2,
      logger: silentLogger
    });

    await scheduler.runOnce();
    await scheduler.runOnce();
    await scheduler.runOnce(); // breaker open for commit-a
    assert.equal(attempts, 2);

    head = "commit-b"; // a new push
    await scheduler.runOnce();
    await scheduler.runOnce();
    await scheduler.runOnce(); // breaker open for commit-b
    assert.equal(attempts, 4, "the new commit got its own two attempts");
  });

  test("circuit breaker: a success clears the breaker so later commits deploy", async () => {
    let succeed = false;
    let attempts = 0;
    const scheduler = createAutoDeployScheduler({
      appDatabase: fakeDb({ candidates: [candidate({ appId: 8, latestDeployedCommitSha: "old" })] }),
      resolveBranchHead: async () => "same-commit",
      triggerDeploy: async () => {
        attempts += 1;
        return succeed;
      },
      maxConsecutiveFailures: 2,
      logger: silentLogger
    });

    await scheduler.runOnce(); // fail 1
    succeed = true;
    await scheduler.runOnce(); // success — clears the breaker
    assert.equal(attempts, 2);

    // A subsequent failing run starts a fresh count rather than being
    // immediately blocked by the old one.
    succeed = false;
    await scheduler.runOnce();
    assert.equal(attempts, 3, "the breaker was cleared by the earlier success");
  });
});
