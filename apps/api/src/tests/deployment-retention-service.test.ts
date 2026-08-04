import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAppDatabase } from "../database.js";
import {
  planAppRetention,
  selectSweepableImages,
  cleanupAppRetention,
  clampRetentionCount,
  resolveRetentionCount,
  normalizeRetentionConfig,
  DEFAULT_RETENTION_CONFIG,
  type AppRetentionInput,
  type PruneImage,
  type RetentionContainer,
  type RetentionDockerOps,
  type RetentionConfig
} from "../services/deployment-retention-service.js";

function deployment(version: number, imageTag: string, isCurrent = false) {
  return { version, imageTag, isCurrent };
}

function appInput(overrides: Partial<AppRetentionInput> & { appId: number }): AppRetentionInput {
  return {
    currentImageTag: `deployment-app-${overrides.appId}:current`,
    retentionCount: 3,
    deployments: [],
    ...overrides
  };
}

describe("config helpers", () => {
  test("clampRetentionCount floors, keeps >= 1, caps at 50", () => {
    assert.equal(clampRetentionCount(0), 1);
    assert.equal(clampRetentionCount(-5), 1);
    assert.equal(clampRetentionCount(3.9), 3);
    assert.equal(clampRetentionCount(1000), 50);
    assert.equal(clampRetentionCount(Number.NaN), DEFAULT_RETENTION_CONFIG.count);
  });

  test("resolveRetentionCount prefers the per-app override", () => {
    assert.equal(resolveRetentionCount({ deploymentRetention: 5 }, 3), 5);
    assert.equal(resolveRetentionCount({ deploymentRetention: null }, 3), 3);
  });

  test("normalizeRetentionConfig fills and clamps", () => {
    assert.deepEqual(normalizeRetentionConfig(null), DEFAULT_RETENTION_CONFIG);
    assert.deepEqual(normalizeRetentionConfig({ count: 0, platformImageKeep: 999 }), {
      count: 1,
      platformImageKeep: 50
    });
  });
});

describe("planAppRetention", () => {
  test("keeps the newest N versions and prunes the rest", () => {
    const plan = planAppRetention([
      appInput({
        appId: 1,
        retentionCount: 3,
        deployments: [
          deployment(1, "deployment-app-1:v1"),
          deployment(2, "deployment-app-1:v2"),
          deployment(3, "deployment-app-1:v3"),
          deployment(4, "deployment-app-1:v4"),
          deployment(5, "deployment-app-1:v5"),
          deployment(6, "deployment-app-1:v6", true)
        ]
      })
    ]);

    const decision = plan.perApp[0];
    assert.deepEqual(decision.retainedVersions.sort((a, b) => a - b), [4, 5, 6]);
    assert.deepEqual(
      decision.prunedVersions.map((v) => v.version).sort((a, b) => a - b),
      [1, 2, 3]
    );
    // Retained tags include the newest three + the app's current image.
    assert.ok(plan.retainedImageTags.has("deployment-app-1:v6"));
    assert.ok(plan.retainedImageTags.has("deployment-app-1:current"));
    assert.ok(!plan.retainedImageTags.has("deployment-app-1:v1"));
  });

  test("always retains the current version even if it is not among the newest N", () => {
    // An unusual ledger where the current flag sits on an older version.
    const plan = planAppRetention([
      appInput({
        appId: 1,
        retentionCount: 1,
        deployments: [
          deployment(1, "deployment-app-1:v1", true),
          deployment(2, "deployment-app-1:v2"),
          deployment(3, "deployment-app-1:v3")
        ]
      })
    ]);

    const decision = plan.perApp[0];
    assert.ok(decision.retainedVersions.includes(3)); // newest (keep = 1)
    assert.ok(decision.retainedVersions.includes(1)); // current, forced
    assert.ok(!decision.prunedVersions.some((v) => v.version === 1));
  });

  test("an image shared by another app's retained version is protected", () => {
    const shared = "deployment-app-1:shared";
    const plan = planAppRetention([
      appInput({
        appId: 1,
        retentionCount: 1,
        deployments: [deployment(1, shared), deployment(2, "deployment-app-1:v2", true)]
      }),
      appInput({
        appId: 2,
        retentionCount: 3,
        // App 2 still retains the shared tag as one of its recent versions.
        deployments: [deployment(1, shared, true)]
      })
    ]);

    // App 1 prunes version 1, but the tag is retained by app 2, so it stays protected.
    assert.deepEqual(plan.perApp[0].prunedVersions.map((v) => v.imageTag), [shared]);
    assert.ok(plan.retainedImageTags.has(shared));
  });
});

describe("selectSweepableImages", () => {
  function image(overrides: Partial<PruneImage> = {}): PruneImage {
    return { id: "sha256:" + Math.random().toString(16).slice(2), size: 100, repoTags: [], created: 0, ...overrides };
  }

  test("selects dangling images", () => {
    const dangling = image({ id: "d1", repoTags: [] });
    const alsoDangling = image({ id: "d2", repoTags: ["<none>:<none>"] });
    const result = selectSweepableImages({
      images: [dangling, alsoDangling],
      referencedTags: new Set(),
      inUseImageIds: new Set(),
      platformKeep: 3
    });
    assert.deepEqual(result.map((i) => i.id).sort(), ["d1", "d2"]);
  });

  test("selects orphaned per-app build images but keeps referenced ones", () => {
    const referenced = image({ id: "keep", repoTags: ["deployment-app-5:live"] });
    const orphan = image({ id: "orphan", repoTags: ["deployment-app-5:dead"] });
    const result = selectSweepableImages({
      images: [referenced, orphan],
      referencedTags: new Set(["deployment-app-5:live"]),
      inUseImageIds: new Set(),
      platformKeep: 3
    });
    assert.deepEqual(result.map((i) => i.id), ["orphan"]);
  });

  test("never selects an image used by any container", () => {
    const orphan = image({ id: "in-use", repoTags: ["deployment-app-5:dead"] });
    const result = selectSweepableImages({
      images: [orphan],
      referencedTags: new Set(),
      inUseImageIds: new Set(["in-use"]),
      platformKeep: 3
    });
    assert.deepEqual(result, []);
  });

  test("keeps the newest platformKeep platform images per repo and sweeps the rest", () => {
    const images: PruneImage[] = [
      image({ id: "api-old", repoTags: ["deployment-platform-api:0.1.0"], created: 100 }),
      image({ id: "api-mid", repoTags: ["deployment-platform-api:0.1.1"], created: 200 }),
      image({ id: "api-new", repoTags: ["deployment-platform-api:0.1.2"], created: 300 }),
      image({ id: "web-only", repoTags: ["deployment-platform-web:0.1.2"], created: 300 })
    ];
    const result = selectSweepableImages({
      images,
      referencedTags: new Set(),
      inUseImageIds: new Set(),
      platformKeep: 1
    });
    // api keeps the newest (api-new); web has only one so it's kept.
    assert.deepEqual(result.map((i) => i.id).sort(), ["api-mid", "api-old"]);
  });

  test("never sweeps an image built within the minimum age window", () => {
    const nowSeconds = 10_000;
    const fresh = image({ id: "fresh", repoTags: ["deployment-app-5:building"], created: nowSeconds - 60 });
    const old = image({ id: "old", repoTags: ["deployment-app-5:stale"], created: nowSeconds - 7200 });
    const result = selectSweepableImages({
      images: [fresh, old],
      referencedTags: new Set(),
      inUseImageIds: new Set(),
      platformKeep: 3,
      now: nowSeconds,
      minAgeSeconds: 3600
    });
    // The fresh (possibly in-flight) build is protected; the old orphan is swept.
    assert.deepEqual(result.map((i) => i.id), ["old"]);
  });

  test("never sweeps base images", () => {
    const result = selectSweepableImages({
      images: [image({ id: "nginx", repoTags: ["nginx:alpine"] })],
      referencedTags: new Set(),
      inUseImageIds: new Set(),
      platformKeep: 0
    });
    assert.deepEqual(result, []);
  });
});

// ---- Integration: the impure runner against a real in-memory DB ----

const CONFIG: RetentionConfig = { count: 3, platformImageKeep: 3 };

function buildFakeOps(images: PruneImage[], containers: RetentionContainer[]) {
  const removedImages: string[] = [];
  const removedContainers: string[] = [];
  let failRemoveImage: string | null = null;

  const ops: RetentionDockerOps = {
    listImages: async () => images,
    listContainers: async () => containers,
    removeImageByTag: async (tag) => {
      if (failRemoveImage === tag) {
        throw new Error("simulated docker failure");
      }
      removedImages.push(tag);
    },
    removeContainer: async (id) => {
      removedContainers.push(id);
    }
  };

  return {
    ops,
    removedImages,
    removedContainers,
    failNext: (tag: string) => {
      failRemoveImage = tag;
    }
  };
}

function seedApp(db: ReturnType<typeof createAppDatabase>, name: string, versions: number) {
  const app = db.createApp({ name, image: "nginx:alpine", containerPort: 3000, containerName: name });
  for (let i = 1; i <= versions; i += 1) {
    db.recordDeployment({
      appId: app.id,
      imageTag: `deployment-app-${app.id}:v${i}`,
      commitSha: `sha${i}`,
      commitMessage: `commit ${i}`,
      sourceKind: "github"
    });
  }
  return app;
}

describe("cleanupAppRetention (runner)", () => {
  test("prunes versions beyond the keep count: image + ledger row + leftover container", async () => {
    const db = createAppDatabase(":memory:");
    const app = seedApp(db, "app-x", 5); // versions 1..5, v5 current

    const images: PruneImage[] = [1, 2, 3, 4, 5].map((v) => ({
      id: `img-${v}`,
      size: 1000,
      repoTags: [`deployment-app-${app.id}:v${v}`],
      created: v
    }));
    const containers: RetentionContainer[] = [
      { id: "live", names: ["app-x"], imageId: "img-5", managed: true, running: true },
      { id: "leftover", names: ["app-x-rollback-abc"], imageId: "img-4", managed: true, running: false },
      { id: "leftover-running", names: ["app-x-github-deploy-xyz"], imageId: "img-9", managed: true, running: true },
      { id: "unmanaged", names: ["app-x-rollback-def"], imageId: "img-base", managed: false, running: false }
    ];
    const fake = buildFakeOps(images, containers);

    const result = await cleanupAppRetention(
      { appDatabase: db, dockerOps: fake.ops, config: CONFIG },
      app.id
    );

    // Keep 3 (v3,v4,v5); prune v1,v2.
    assert.equal(result.versionsPruned, 2);
    assert.deepEqual(fake.removedImages.sort(), [
      `deployment-app-${app.id}:v1`,
      `deployment-app-${app.id}:v2`
    ]);
    assert.equal(result.imagesDeleted, 2);
    assert.equal(result.bytesReclaimed, 2000);

    // Ledger now only lists the retained versions.
    assert.deepEqual(
      db.listGithubDeployments(app.id).map((d) => d.version),
      [5, 4, 3]
    );

    // Only the managed, non-running, name-matching leftover is removed.
    assert.deepEqual(fake.removedContainers, ["leftover"]);
    assert.ok(!fake.removedContainers.includes("live"));
    assert.ok(!fake.removedContainers.includes("leftover-running"));
    assert.ok(!fake.removedContainers.includes("unmanaged"));
    assert.equal(result.failures.length, 0);
  });

  test("never removes an image still used by a container, but still prunes its ledger row", async () => {
    const db = createAppDatabase(":memory:");
    const app = seedApp(db, "app-y", 5);

    const images: PruneImage[] = [1, 2, 3, 4, 5].map((v) => ({
      id: `img-${v}`,
      size: 1000,
      repoTags: [`deployment-app-${app.id}:v${v}`],
      created: v
    }));
    // A stopped container still pins v1's image id.
    const containers: RetentionContainer[] = [
      { id: "live", names: ["app-y"], imageId: "img-5", managed: true, running: true },
      { id: "pins-v1", names: ["something"], imageId: "img-1", managed: true, running: false }
    ];
    const fake = buildFakeOps(images, containers);

    const result = await cleanupAppRetention(
      { appDatabase: db, dockerOps: fake.ops, config: CONFIG },
      app.id
    );

    // v1 image is in use → not removed; v2 image → removed.
    assert.deepEqual(fake.removedImages, [`deployment-app-${app.id}:v2`]);
    // Both rows are still pruned (history shows only retained versions).
    assert.equal(result.versionsPruned, 2);
    assert.deepEqual(
      db.listGithubDeployments(app.id).map((d) => d.version),
      [5, 4, 3]
    );
  });

  test("is idempotent — a second run reclaims nothing", async () => {
    const db = createAppDatabase(":memory:");
    const app = seedApp(db, "app-z", 4);
    const images: PruneImage[] = [1, 2, 3, 4].map((v) => ({
      id: `img-${v}`,
      size: 1000,
      repoTags: [`deployment-app-${app.id}:v${v}`],
      created: v
    }));
    const containers: RetentionContainer[] = [
      { id: "live", names: ["app-z"], imageId: "img-4", managed: true, running: true }
    ];
    const fake = buildFakeOps(images, containers);
    const deps = { appDatabase: db, dockerOps: fake.ops, config: CONFIG };

    const first = await cleanupAppRetention(deps, app.id);
    assert.equal(first.versionsPruned, 1);

    const second = await cleanupAppRetention(deps, app.id);
    assert.equal(second.versionsPruned, 0);
    assert.equal(second.imagesDeleted, 0);
    assert.equal(second.containersRemoved, 0);
  });

  test("isolates a docker removal failure and still succeeds", async () => {
    const db = createAppDatabase(":memory:");
    const app = seedApp(db, "app-f", 5);
    const images: PruneImage[] = [1, 2, 3, 4, 5].map((v) => ({
      id: `img-${v}`,
      size: 1000,
      repoTags: [`deployment-app-${app.id}:v${v}`],
      created: v
    }));
    const containers: RetentionContainer[] = [
      { id: "live", names: ["app-f"], imageId: "img-5", managed: true, running: true }
    ];
    const fake = buildFakeOps(images, containers);
    fake.failNext(`deployment-app-${app.id}:v1`);

    const result = await cleanupAppRetention(
      { appDatabase: db, dockerOps: fake.ops, config: CONFIG },
      app.id
    );

    // v1 removal failed (recorded), v2 removal succeeded, and both rows are pruned.
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /v1/);
    assert.deepEqual(fake.removedImages, [`deployment-app-${app.id}:v2`]);
    assert.equal(result.versionsPruned, 2);
  });

  test("does nothing for an app within its keep count", async () => {
    const db = createAppDatabase(":memory:");
    const app = seedApp(db, "app-small", 2);
    const fake = buildFakeOps([], [
      { id: "live", names: ["app-small"], imageId: "img-2", managed: true, running: true }
    ]);

    const result = await cleanupAppRetention(
      { appDatabase: db, dockerOps: fake.ops, config: CONFIG },
      app.id
    );

    assert.equal(result.versionsPruned, 0);
    assert.equal(result.imagesDeleted, 0);
    assert.deepEqual(db.listGithubDeployments(app.id).map((d) => d.version), [2, 1]);
  });
});
