import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateCaddyConfig } from "../services/routing-service.js";
import type { StoredApp } from "../database.js";

function makeApp(overrides: Partial<StoredApp>): StoredApp {
  return {
    id: 1,
    name: "sqlite-test",
    containerId: "abc123",
    containerName: "app-sqlite-test",
    image: "nginx:alpine",
    containerPort: 80,
    domain: "sqlite-test.apps.hookstats.com",
    internalOnly: false,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployedAt: "2026-01-01T00:00:00.000Z",
    environmentTouchedAt: null,
    memoryLimitMb: null,
    cpuLimit: null,
    deploymentRetention: null,
    ...overrides
  };
}

describe("generateCaddyConfig", () => {
  test("emits one reverse_proxy block per routed app", () => {
    const config = generateCaddyConfig([
      makeApp({ name: "app-one", domain: "app-one.apps.hookstats.com", containerName: "app-app-one" }),
      makeApp({ name: "app-two", domain: "app-two.apps.hookstats.com", containerName: "app-app-two", containerPort: 8080 })
    ]);

    assert.match(config, /app-one\.apps\.hookstats\.com \{/);
    assert.match(config, /reverse_proxy app-app-one:80/);
    assert.match(config, /app-two\.apps\.hookstats\.com \{/);
    assert.match(config, /reverse_proxy app-app-two:8080/);
  });

  test("skips apps with no domain assigned", () => {
    const config = generateCaddyConfig([makeApp({ domain: null })]);
    assert.equal(config, "");
  });

  test("skips apps with a name that fails the safe-label check", () => {
    const config = generateCaddyConfig([
      makeApp({ name: "not valid", domain: "not-valid.apps.hookstats.com" })
    ]);

    assert.equal(config, "");
  });

  test("skips apps with an out-of-range container port", () => {
    const config = generateCaddyConfig([
      makeApp({ containerPort: 0 }),
      makeApp({ containerPort: 70000 })
    ]);

    assert.equal(config, "");
  });

  test("returns an empty string for no apps", () => {
    assert.equal(generateCaddyConfig([]), "");
  });
});
