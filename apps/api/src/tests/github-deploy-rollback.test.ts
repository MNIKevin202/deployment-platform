import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { deployFromGithub, type GithubDeployDependencies } from "../services/github-deploy-service.js";
import type { SourceProviderClient } from "../services/source-provider.js";
import type { RecordEventFn } from "../services/deployment-event-service.js";
import type { HealthCheckHttpClient } from "../services/health-check-service.js";

/**
 * These tests drive the REAL deployFromGithub pipeline through its container
 * swap, cloning a tiny local git repository (via the test-only
 * cloneUrlOverride) so the clone/inspect/build-plan steps are genuine, then
 * controlling the container lifecycle and health outcome with an in-memory
 * fake Docker registry. The point is to prove the preserve-then-swap
 * lifecycle: the previous container is renamed aside BEFORE it is displaced,
 * a failed deploy restores it, and a first deployment with no previous
 * container never reports a fake rollback failure.
 */

function buildFakeBareRepoWithRootDockerfile(): string {
  const scratch = mkdtempSync(join(tmpdir(), "rollback-fixture-"));
  const workRepo = join(scratch, "work");
  mkdirSync(workRepo, { recursive: true });

  // A Dockerfile at the repository root makes inspection recommend the
  // "dockerfile" strategy with no operator override needed.
  writeFileSync(join(workRepo, "Dockerfile"), "FROM scratch\n");

  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: scratch };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workRepo, env });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: workRepo, env });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: workRepo, env });
  execFileSync("git", ["add", "-A"], { cwd: workRepo, env });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: workRepo, env });

  const bareRepo = join(scratch, "repo.git");
  execFileSync("git", ["clone", "-q", "--bare", workRepo, bareRepo], { env });

  return bareRepo;
}

interface FakeContainer {
  id: string;
  running: boolean;
}

interface FakeDockerOptions {
  currentName: string;
  seedCurrentContainer: boolean;
  imageExists?: boolean;
  startReplacementFails?: boolean;
  replacementNeverRunning?: boolean;
  replacementNetworkAddress?: string;
  /** Managed-network IP reported for the seeded (old/restored) container. */
  currentNetworkAddress?: string;
}

function dockerNotFound(): Error {
  const error = new Error("No such container") as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}

/**
 * An in-memory Docker container registry keyed by name, with a parallel id
 * index, that records every operation in call order so tests can assert
 * ordering (e.g. the old container is preserved before it is displaced).
 */
function createFakeDocker(options: FakeDockerOptions) {
  const byName = new Map<string, FakeContainer>();
  const ops: string[] = [];
  let nextReplacementId = 1;

  if (options.seedCurrentContainer) {
    byName.set(options.currentName, { id: "old-container-id", running: true });
  }

  function findByIdOrName(idOrName: string): [string, FakeContainer] | null {
    const direct = byName.get(idOrName);
    if (direct) {
      return [idOrName, direct];
    }
    for (const [name, container] of byName) {
      if (container.id === idOrName) {
        return [name, container];
      }
    }
    return null;
  }

  const dockerOps: GithubDeployDependencies["dockerOps"] = {
    async pullImage() {},
    async imageExists() {
      return options.imageExists ?? false;
    },
    async buildImage() {
      ops.push("buildImage");
      return { log: "", truncated: false };
    },
    async ensureVolume() {},
    async createContainer(createOptions) {
      const name = (createOptions as { name: string }).name;
      const id = `replacement-id-${nextReplacementId++}`;
      byName.set(name, { id, running: false });
      ops.push(`createContainer:${name}`);
      return { id };
    },
    async startContainer(id) {
      ops.push(`startContainer:${id}`);
      const found = findByIdOrName(id);
      if (found && found[1].id.startsWith("replacement") && options.startReplacementFails) {
        throw new Error("simulated replacement start failure");
      }
      if (found) {
        found[1].running = true;
      }
    },
    async inspectContainer(id) {
      const found = findByIdOrName(id);
      if (!found) {
        throw dockerNotFound();
      }
      const [, container] = found;
      let running = container.running;
      if (container.id.startsWith("replacement") && options.replacementNeverRunning) {
        running = false;
      }
      const isReplacement = container.id.startsWith("replacement");
      const address = isReplacement
        ? options.replacementNetworkAddress
        : options.currentNetworkAddress;
      return {
        id: container.id,
        running,
        status: running ? "running" : "created",
        networkAddresses: address ? { "deployment-apps": address } : undefined
      };
    },
    async containerExists(name) {
      ops.push(`containerExists:${name}`);
      return byName.has(name);
    },
    async stopContainer(name) {
      ops.push(`stopContainer:${name}`);
      const container = byName.get(name);
      if (container) {
        container.running = false;
      }
    },
    async removeContainer(idOrName) {
      ops.push(`removeContainer:${idOrName}`);
      const found = findByIdOrName(idOrName);
      if (found) {
        byName.delete(found[0]);
      }
    },
    async renameContainer(idOrName, newName) {
      ops.push(`renameContainer:${idOrName}->${newName}`);
      const found = findByIdOrName(idOrName);
      if (!found) {
        throw dockerNotFound();
      }
      const [oldName, container] = found;
      byName.delete(oldName);
      byName.set(newName, container);
    },
    async refreshNetworkEndpoint(containerId, networkName) {
      // Record BY ID so tests can prove the exact promoted/restored container
      // was refreshed — never an unrelated or proxy container.
      const found = findByIdOrName(containerId);
      ops.push(`refreshNetworkEndpoint:${found ? found[1].id : containerId}:${networkName}`);
      if (!found) {
        throw dockerNotFound();
      }
    }
  };

  return { ops, byName, dockerOps };
}

function fakeHttpClient(reachable: boolean): HealthCheckHttpClient {
  return {
    async request() {
      if (reachable) {
        return { statusCode: 200, latencyMs: 1 };
      }
      const error = new Error("connect ECONNREFUSED 172.18.0.9:4319") as Error & { code: string };
      error.code = "ECONNREFUSED";
      throw error;
    }
  };
}

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};

function unusedGithubClient(): SourceProviderClient {
  const fail = () => {
    throw new Error("unexpectedly called in this test");
  };
  return {
    provider: "github",
    validateCredential: fail,
    listRepositories: fail,
    getRepository: fail,
    listBranches: fail,
    listCommits: fail,
    resolveBranchCommit: fail,
    pathExists: fail,
    getFileContents: fail
  };
}

const FAKE_TOKEN = "ghs_fake-rollback-fixture-token";

describe("deployFromGithub — preserve-then-swap rollback lifecycle", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let bareRepo: string;
  let recordedEvents: Array<{ eventType: string; message: string; metadata?: Record<string, unknown> }>;
  let recordEvent: RecordEventFn;
  let reconcileCalls: number;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "github-deploy-rollback-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
    bareRepo = buildFakeBareRepoWithRootDockerfile();
    recordedEvents = [];
    recordEvent = (input) => {
      recordedEvents.push({ eventType: input.eventType, message: input.message, metadata: input.metadata });
    };
    reconcileCalls = 0;
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(join(bareRepo, ".."), { recursive: true, force: true });
  });

  function makeApp(name: string) {
    return appDatabase.createApp({
      name,
      image: "nginx:alpine",
      containerPort: 4319,
      containerName: `app-${name}`
    });
  }

  function configureSource(appId: number) {
    appDatabase.upsertAppSource(appId, {
      provider: "github",
      repositoryOwner: "MNIKevin202",
      repositoryName: "DeploymentPlatformInstaller",
      repositoryFullName: "MNIKevin202/DeploymentPlatformInstaller",
      repositoryCloneUrl: "https://github.com/MNIKevin202/DeploymentPlatformInstaller.git",
      repositoryId: null,
      repositoryVisibility: null,
      branch: "main",
      subdirectory: ".",
      deploymentMode: "dockerfile",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      selectedStrategy: "dockerfile",
      containerPort: 4319,
      autoDeploy: false
    });
  }

  function makeDeps(
    fake: ReturnType<typeof createFakeDocker>,
    healthReachable: boolean,
    extra: Partial<GithubDeployDependencies> = {}
  ): GithubDeployDependencies {
    return {
      appDatabase,
      dockerOps: fake.dockerOps,
      githubClient: {
        ...unusedGithubClient(),
        resolveBranchCommit: async () => "d".repeat(40),
        listCommits: async () => ({ items: [], hasMore: false })
      },
      resolveCredential: async () => ({ success: true, token: FAKE_TOKEN, source: "installation" }),
      reconcileRouting: async () => {
        reconcileCalls += 1;
        return { lastReconcileSucceeded: true, lastError: null };
      },
      recordEvent,
      healthCheckDeps: {
        httpClient: fakeHttpClient(healthReachable),
        isContainerRunning: async () => true,
        logger: silentLogger
      },
      cloneUrlOverride: `file://${bareRepo}`,
      // Fast, deterministic readiness loop for tests.
      dnsReadiness: { attempts: 3, delayMs: 1 },
      ...extra
    };
  }

  test("an existing live container is preserved (stopped + renamed aside) BEFORE the replacement takes over the live name, and is never removed first", async () => {
    const app = makeApp("has-current");
    configureSource(app.id);
    const fake = createFakeDocker({ currentName: app.containerName!, seedCurrentContainer: true });

    // Health fails so the deploy reaches the swap then rolls back — but the
    // ordering assertions below hold regardless of the eventual outcome.
    const result = await deployFromGithub(makeDeps(fake, false), app.id);
    assert.equal(result.success, false);

    const preserveRename = fake.ops.findIndex((op) => op.startsWith(`renameContainer:${app.containerName}->`));
    const takeoverRename = fake.ops.findIndex((op) => op.endsWith(`->${app.containerName}`));
    assert.ok(preserveRename >= 0, "the current container must be renamed to a rollback name");
    assert.ok(takeoverRename >= 0, "the replacement must be renamed into the live name");
    assert.ok(preserveRename < takeoverRename, "preservation must happen before the replacement takes the live name");

    // The old container id is never removed while it still holds (or backs)
    // the live name — it is only ever renamed aside, never destroyed here.
    const removedOldBeforePreserve = fake.ops
      .slice(0, preserveRename)
      .some((op) => op === "removeContainer:old-container-id" || op === `removeContainer:${app.containerName}`);
    assert.equal(removedOldBeforePreserve, false, "the old container must not be removed before preservation");
  });

  test("a health failure restores the preserved container: it is renamed back, started, inspected, and the DB is pointed at it — final status ROLLED_BACK", async () => {
    const app = makeApp("restore-preserved");
    configureSource(app.id);
    const fake = createFakeDocker({ currentName: app.containerName!, seedCurrentContainer: true });

    const result = await deployFromGithub(makeDeps(fake, false), app.id);

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);
    assert.match(result.message, /previous version was restored/);

    // The live name is backed by the ORIGINAL container again, and running.
    const live = fake.byName.get(app.containerName!);
    assert.ok(live, "a container must occupy the live name after rollback");
    assert.equal(live!.id, "old-container-id");
    assert.equal(live!.running, true);

    // The rollback container name no longer lingers.
    const lingering = [...fake.byName.keys()].filter((name) => name.includes("-rollback-"));
    assert.deepEqual(lingering, []);

    // Restore path exercised the expected operations, in order.
    assert.ok(fake.ops.some((op) => op === `startContainer:${app.containerName}`), "restored container is started");
    assert.ok(
      fake.ops.some((op) => op.startsWith(`renameContainer:`) && op.endsWith(`->${app.containerName}`)),
      "rollback container is renamed back to the live name"
    );

    // Database container id/status restored to the original container.
    const stored = appDatabase.getAppById(app.id);
    assert.equal(stored?.containerId, "old-container-id");

    // Distinct status persisted on the source, and the event is a rollback.
    const source = appDatabase.getAppSource(app.id);
    assert.equal(source?.lastDeploymentStatus, "ROLLED_BACK");
    assert.ok(recordedEvents.some((event) => event.eventType === "github-deploy-rolled-back"));
    assert.equal(reconcileCalls, 0, "routing is not reconciled on the rollback path — the live name is restored intact");
  });

  test("a successful deployment removes the preserved rollback container only AFTER health verification", async () => {
    const app = makeApp("success-cleanup");
    configureSource(app.id);
    const fake = createFakeDocker({ currentName: app.containerName!, seedCurrentContainer: true });

    const result = await deployFromGithub(makeDeps(fake, true), app.id);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, false);

    // The live name is backed by the NEW replacement, running.
    const live = fake.byName.get(app.containerName!);
    assert.ok(live);
    assert.ok(live!.id.startsWith("replacement"));
    assert.equal(live!.running, true);

    // No rollback container remains.
    const lingering = [...fake.byName.keys()].filter((name) => name.includes("-rollback-"));
    assert.deepEqual(lingering, []);

    // The rollback container was removed AFTER the build+health verification.
    const buildIndex = fake.ops.findIndex((op) => op === "buildImage");
    const rollbackRemoveIndex = fake.ops.findIndex(
      (op) => op.startsWith("removeContainer:") && op.includes("-rollback-")
    );
    assert.ok(rollbackRemoveIndex > buildIndex, "the preserved container is only removed after verification");

    const source = appDatabase.getAppSource(app.id);
    assert.equal(source?.lastDeploymentStatus, "PASS");
  });

  test("internal verification targets the replacement's immutable managed-network address", async () => {
    const app = makeApp("network-address-health");
    configureSource(app.id);
    const replacementNetworkAddress = "172.19.0.42";
    const fake = createFakeDocker({
      currentName: app.containerName!,
      seedCurrentContainer: true,
      replacementNetworkAddress
    });
    const deps = makeDeps(fake, true);
    const requestedHostnames: string[] = [];
    deps.healthCheckDeps!.httpClient = {
      async request(options) {
        requestedHostnames.push(options.hostname);
        return { statusCode: 200, latencyMs: 1 };
      }
    };

    const result = await deployFromGithub(deps, app.id);

    assert.equal(result.success, true);
    assert.deepEqual(requestedHostnames, [replacementNetworkAddress]);
  });

  test("a failure BEFORE the swap (replacement never reaches running) leaves the old container completely untouched — clean FAILED, not a rollback", async () => {
    const app = makeApp("pre-swap-failure");
    configureSource(app.id);
    const fake = createFakeDocker({
      currentName: app.containerName!,
      seedCurrentContainer: true,
      replacementNeverRunning: true
    });

    const result = await deployFromGithub(makeDeps(fake, true), app.id);

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.equal(result.stage, "starting-replacement");

    // Old container is exactly as it was: still holding the live name, running.
    const live = fake.byName.get(app.containerName!);
    assert.ok(live);
    assert.equal(live!.id, "old-container-id");
    assert.equal(live!.running, true);

    // It was never renamed aside or removed.
    assert.equal(
      fake.ops.some((op) => op.startsWith(`renameContainer:${app.containerName}->`)),
      false
    );

    const source = appDatabase.getAppSource(app.id);
    assert.equal(source?.lastDeploymentStatus, "FAILED");
    assert.ok(recordedEvents.some((event) => event.eventType === "github-deploy-failed"));
  });

  test("a first deployment with NO previous container succeeds (missing-container recovery)", async () => {
    const app = makeApp("first-deploy-success");
    configureSource(app.id);
    const fake = createFakeDocker({ currentName: app.containerName!, seedCurrentContainer: false });

    const result = await deployFromGithub(makeDeps(fake, true), app.id);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, false);

    const live = fake.byName.get(app.containerName!);
    assert.ok(live);
    assert.ok(live!.id.startsWith("replacement"));
    assert.equal(live!.running, true);

    // No preserve/rollback container was ever created.
    assert.equal(
      fake.ops.some((op) => op.includes("-rollback-")),
      false
    );
  });

  test("a first-deployment HEALTH failure removes only the failed replacement and does NOT report a fake rollback failure", async () => {
    const app = makeApp("first-deploy-health-fail");
    configureSource(app.id);
    const fake = createFakeDocker({ currentName: app.containerName!, seedCurrentContainer: false });

    const result = await deployFromGithub(makeDeps(fake, false), app.id);

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.doesNotMatch(result.message, /rollback/i);

    // The failed replacement was removed; nothing occupies the live name.
    assert.equal(fake.byName.has(app.containerName!), false);

    // A plain FAILED status — never ROLLBACK_FAILED — and a failed (not
    // rolled-back) event.
    const source = appDatabase.getAppSource(app.id);
    assert.equal(source?.lastDeploymentStatus, "FAILED");
    assert.ok(recordedEvents.some((event) => event.eventType === "github-deploy-failed"));
    assert.equal(
      recordedEvents.some((event) => event.eventType === "github-deploy-rolled-back"),
      false,
      "a first deployment must never emit a rolled-back event"
    );
  });

  test("regression fixture: existing container + replacement starts + health ECONNREFUSED -> old container restored, final status ROLLED_BACK (never ROLLBACK_FAILED)", async () => {
    const app = makeApp("econnrefused-regression");
    configureSource(app.id);
    const fake = createFakeDocker({ currentName: app.containerName!, seedCurrentContainer: true });

    const result = await deployFromGithub(makeDeps(fake, false), app.id);

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);

    const live = fake.byName.get(app.containerName!);
    assert.equal(live?.id, "old-container-id");
    assert.equal(live?.running, true);

    const source = appDatabase.getAppSource(app.id);
    assert.equal(source?.lastDeploymentStatus, "ROLLED_BACK");
    assert.notEqual(source?.lastDeploymentStatus, "ROLLBACK_FAILED");
  });

  test("no secret token ever appears in recorded event messages or metadata", async () => {
    const app = makeApp("no-secret-leak");
    configureSource(app.id);
    const fake = createFakeDocker({ currentName: app.containerName!, seedCurrentContainer: false });

    await deployFromGithub(makeDeps(fake, false), app.id);

    const serialized = JSON.stringify(recordedEvents);
    assert.equal(serialized.includes(FAKE_TOKEN), false);
    assert.equal(serialized.includes("ghs_"), false);
  });

  // ── Post-rename Docker embedded-DNS re-registration + readiness ──────────
  //
  // These cover the isolated bug: `docker rename` leaves the managed network's
  // embedded DNS stale, so the canonical hostname fails to resolve, or
  // resolves to the WRONG IP (observed: Caddy's own IP). The fix re-registers
  // the promoted container's endpoint (disconnect+reconnect BY ID) and gates
  // the public route check on the hostname resolving to the container's EXACT
  // IP.

  function makeAppWithDomain(name: string) {
    const app = appDatabase.createApp({
      name,
      image: "nginx:alpine",
      containerPort: 4319,
      containerName: `app-${name}`,
      domain: `${name}.apps.example.com`
    });
    configureSource(app.id);
    return app;
  }

  /** Stubs global fetch (the public route check) and records call count. */
  function stubPublicFetch(status = 200): { restore: () => void; calls: () => number } {
    const original = globalThis.fetch;
    let count = 0;
    globalThis.fetch = (async () => {
      count += 1;
      return { status } as Response;
    }) as typeof fetch;
    return { restore: () => { globalThis.fetch = original; }, calls: () => count };
  }

  test("promotion refreshes the promoted container's exact endpoint, waits for its IP, then passes the public route", async () => {
    const app = makeAppWithDomain("yumbot-ok");
    const appIp = "172.23.0.5";
    const fake = createFakeDocker({
      currentName: app.containerName!,
      seedCurrentContainer: true,
      replacementNetworkAddress: appIp
    });

    const resolvedFor: string[] = [];
    const publicFetch = stubPublicFetch(200);
    let result;
    try {
      result = await deployFromGithub(
        makeDeps(fake, true, {
          resolveHostAddresses: async (hostname) => {
            resolvedFor.push(hostname);
            return [appIp]; // correct IP
          }
        }),
        app.id
      );
    } finally {
      publicFetch.restore();
    }

    assert.equal(result.success, true);

    // Exactly one endpoint refresh, targeting the promoted container BY ID, on
    // the managed-app network — never Caddy/api/rollback, never another network.
    const refreshOps = fake.ops.filter((op) => op.startsWith("refreshNetworkEndpoint:"));
    assert.deepEqual(refreshOps, ["refreshNetworkEndpoint:replacement-id-1:deployment-apps"]);

    // Readiness resolved the canonical hostname (not an IP, not Caddy).
    assert.ok(resolvedFor.includes(app.containerName!));

    // The public route was verified — and only after readiness ran.
    assert.equal(publicFetch.calls(), 1);
  });

  test("a hostname resolving to the WRONG IP (Caddy's own) is rejected: public route is never attempted, deploy rolls back with a DNS-readiness diagnostic", async () => {
    const app = makeAppWithDomain("yumbot-wrongip");
    const appIp = "172.23.0.5";
    const caddyIp = "172.23.0.2";
    const fake = createFakeDocker({
      currentName: app.containerName!,
      seedCurrentContainer: true,
      replacementNetworkAddress: appIp
    });

    const publicFetch = stubPublicFetch(200);
    let result;
    try {
      result = await deployFromGithub(
        makeDeps(fake, true, {
          // Resolves fine (exit 0) but to Caddy's own IP — must NOT be accepted.
          resolveHostAddresses: async () => [caddyIp]
        }),
        app.id
      );
    } finally {
      publicFetch.restore();
    }

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);
    assert.match(result.message, /network\/DNS readiness/i);

    // The failure names the wrong IP it saw and the expected IP.
    const failureEvent = recordedEvents.find((e) => /DNS/i.test(e.message) && /did not become ready/i.test(e.message));
    assert.ok(failureEvent, "a DNS-readiness failure event is recorded");
    assert.ok(failureEvent!.message.includes(appIp), "names the expected app IP");

    // The public route check must NEVER run when DNS points at the wrong IP.
    assert.equal(publicFetch.calls(), 0);
  });

  test("a transient DNS lookup failure retries within the window and then succeeds", async () => {
    const app = makeAppWithDomain("yumbot-transient");
    const appIp = "172.23.0.5";
    const fake = createFakeDocker({
      currentName: app.containerName!,
      seedCurrentContainer: true,
      replacementNetworkAddress: appIp
    });

    let attempts = 0;
    const publicFetch = stubPublicFetch(200);
    let result;
    try {
      result = await deployFromGithub(
        makeDeps(fake, true, {
          resolveHostAddresses: async () => {
            attempts += 1;
            if (attempts < 2) {
              const err = new Error("querySrv ETIMEOUT app-yumbot-transient") as Error & { code: string };
              err.code = "ETIMEOUT";
              throw err;
            }
            return [appIp];
          }
        }),
        app.id
      );
    } finally {
      publicFetch.restore();
    }

    assert.equal(result.success, true);
    assert.ok(attempts >= 2, "the readiness loop retried past the transient failure");
    assert.equal(publicFetch.calls(), 1);
  });

  test("a permanent DNS failure fails with a Docker DNS diagnostic — not a generic public 502 — and never hits the public route", async () => {
    const app = makeAppWithDomain("yumbot-perma");
    const fake = createFakeDocker({
      currentName: app.containerName!,
      seedCurrentContainer: true,
      replacementNetworkAddress: "172.23.0.5"
    });

    const publicFetch = stubPublicFetch(200);
    let result;
    try {
      result = await deployFromGithub(
        makeDeps(fake, true, {
          resolveHostAddresses: async () => {
            const err = new Error("getaddrinfo ENOTFOUND app-yumbot-perma") as Error & { code: string };
            err.code = "ENOTFOUND";
            throw err;
          }
        }),
        app.id
      );
    } finally {
      publicFetch.restore();
    }

    assert.equal(result.success, false);
    assert.match(result.message, /network\/DNS readiness/i);
    assert.doesNotMatch(result.message, /public route returned/i);
    assert.equal(publicFetch.calls(), 0);
  });

  test("rollback also refreshes the RESTORED container's endpoint and validates its IP", async () => {
    const app = makeAppWithDomain("yumbot-rollback-dns");
    const restoredIp = "172.23.0.9";
    // Health fails -> internal check throws -> rollback restores the old
    // container, which is renamed back to the canonical name (same DNS hazard).
    const fake = createFakeDocker({
      currentName: app.containerName!,
      seedCurrentContainer: true,
      replacementNetworkAddress: "172.23.0.5",
      currentNetworkAddress: restoredIp
    });

    const result = await deployFromGithub(
      makeDeps(fake, false, {
        // During rollback the canonical hostname must resolve to the RESTORED
        // container's own IP.
        resolveHostAddresses: async () => [restoredIp]
      }),
      app.id
    );

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);

    // The restored (old) container's endpoint was refreshed BY ID.
    assert.ok(
      fake.ops.includes("refreshNetworkEndpoint:old-container-id:deployment-apps"),
      "the restored container's managed endpoint is refreshed"
    );

    // Rollback recorded that DNS resolved to the restored IP.
    const rollbackEvent = recordedEvents.find((e) => e.eventType === "github-deploy-rolled-back");
    assert.ok(rollbackEvent);
    assert.equal((rollbackEvent!.metadata as { rollbackDnsReady?: boolean }).rollbackDnsReady, true);
  });
});
