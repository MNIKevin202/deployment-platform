import { describe, expect, test } from "vitest";
import { computePlatformHealth, type AttentionItem } from "../lib/platformHealth";
import type { ContainerSummary, DockerInfo, RoutingStatus, StoredApp } from "../types/api";

const GiB = 1024 * 1024 * 1024;

function app(overrides: Partial<StoredApp> & { id: number; name: string }): StoredApp {
  return {
    containerId: null,
    containerName: `app-${overrides.name}`,
    image: "nginx:alpine",
    containerPort: 3000,
    domain: null,
    internalOnly: false,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    memoryLimitMb: null,
    cpuLimit: null,
    createdAt: "",
    updatedAt: "",
    lastDeployedAt: null,
    routingReady: true,
    health: null,
    latestEventSeverity: null,
    latestEventType: null,
    ...overrides
  } as StoredApp;
}

function container(overrides: Partial<ContainerSummary> & { image: string; state: string; appName?: string }): ContainerSummary {
  return {
    id: `c-${Math.random().toString(16).slice(2)}`,
    shortId: "abc123",
    names: [],
    created: 0,
    ports: [],
    labels: overrides.appName ? { "com.deployment-platform.app-name": overrides.appName } : {},
    isSystemContainer: false,
    isManagedApp: true,
    status: overrides.state,
    ...overrides
  } as ContainerSummary;
}

const CONNECTED_DOCKER: DockerInfo = {
  status: "connected",
  containers: 1,
  containersRunning: 1,
  containersStopped: 0,
  images: 1,
  dockerVersion: "29.0.0",
  operatingSystem: "linux",
  architecture: "x86_64",
  cpuCount: 4,
  memoryTotalBytes: 8 * GiB
};

const ACTIVE_ROUTING: RoutingStatus = {
  enabled: true,
  active: true,
  lastReconciledAt: null,
  lastReconcileSucceeded: true,
  lastError: null,
  routedAppCount: 1,
  rejectedRouteCount: 0
};

function baseInput(overrides: Partial<Parameters<typeof computePlatformHealth>[0]> = {}) {
  return {
    managedApps: [] as ContainerSummary[],
    storedAppsByName: new Map<string, StoredApp>(),
    dockerInfo: CONNECTED_DOCKER,
    routingStatus: ACTIVE_ROUTING,
    diskUsage: null,
    autoBackup: null,
    ...overrides
  };
}

function findItem(items: AttentionItem[], category: string): AttentionItem | undefined {
  return items.find((item) => item.category === category);
}

describe("computePlatformHealth", () => {
  test("healthy with no signals at all", () => {
    const result = computePlatformHealth(baseInput());
    expect(result.status).toBe("healthy");
    expect(result.items).toEqual([]);
  });

  test("stopped app produces a warning item referencing the app", () => {
    const stopped = app({ id: 1, name: "worker" });
    const result = computePlatformHealth(
      baseInput({
        managedApps: [container({ image: "myorg/worker:latest", state: "exited", appName: "worker" })],
        storedAppsByName: new Map([["worker", stopped]])
      })
    );

    const item = findItem(result.items, "stopped-app");
    expect(item?.severity).toBe("warning");
    expect(item?.app?.id).toBe(1);
    expect(result.status).toBe("warning");
  });

  test("database images are never flagged as stopped apps", () => {
    const result = computePlatformHealth(
      baseInput({
        managedApps: [container({ image: "postgres:16-alpine", state: "exited", appName: "db" })],
        storedAppsByName: new Map([["db", app({ id: 2, name: "db" })]])
      })
    );
    expect(findItem(result.items, "stopped-app")).toBeUndefined();
  });

  test("stopped-app detection is suppressed while Docker itself is unreachable (avoids false positives)", () => {
    const result = computePlatformHealth(
      baseInput({
        dockerInfo: { ...CONNECTED_DOCKER, status: "unavailable" },
        managedApps: [container({ image: "myorg/worker:latest", state: "exited", appName: "worker" })],
        storedAppsByName: new Map([["worker", app({ id: 1, name: "worker" })]])
      })
    );
    expect(findItem(result.items, "stopped-app")).toBeUndefined();
    const dockerItem = findItem(result.items, "docker-unreachable");
    expect(dockerItem?.severity).toBe("critical");
    expect(result.status).toBe("critical");
  });

  test("a failed deployment (matching failure event types) produces a warning", () => {
    const failed = app({ id: 3, name: "api", latestEventSeverity: "error", latestEventType: "github-deploy-failed" });
    const result = computePlatformHealth(baseInput({ storedAppsByName: new Map([["api", failed]]) }));
    const item = findItem(result.items, "deploy-failed");
    expect(item?.severity).toBe("warning");
    expect(item?.app?.id).toBe(3);
  });

  test("an error-severity event of an unrelated type is not treated as a deploy failure", () => {
    const errored = app({ id: 4, name: "api", latestEventSeverity: "error", latestEventType: "health-check-error" });
    const result = computePlatformHealth(baseInput({ storedAppsByName: new Map([["api", errored]]) }));
    expect(findItem(result.items, "deploy-failed")).toBeUndefined();
  });

  test("an unhealthy or errored health check produces a warning", () => {
    const unhealthy = app({ id: 5, name: "api", health: { state: "unhealthy", lastCheckedAt: null } });
    const result = computePlatformHealth(baseInput({ storedAppsByName: new Map([["api", unhealthy]]) }));
    expect(findItem(result.items, "unhealthy-app")?.severity).toBe("warning");
  });

  test("a public app whose route isn't ready produces a warning", () => {
    const notRouted = app({ id: 6, name: "api", domain: "api.example.com", internalOnly: false, routingReady: false });
    const result = computePlatformHealth(baseInput({ storedAppsByName: new Map([["api", notRouted]]) }));
    expect(findItem(result.items, "unhealthy-route")?.severity).toBe("warning");
  });

  test("an internal-only app is never flagged for routing even if routingReady is false", () => {
    const internal = app({ id: 7, name: "internal", domain: null, internalOnly: true, routingReady: false });
    const result = computePlatformHealth(baseInput({ storedAppsByName: new Map([["internal", internal]]) }));
    expect(findItem(result.items, "unhealthy-route")).toBeUndefined();
  });

  test("routing reconciliation failure produces a platform-wide warning", () => {
    const result = computePlatformHealth(
      baseInput({ routingStatus: { ...ACTIVE_ROUTING, lastReconcileSucceeded: false, lastError: "boom" } })
    );
    const item = findItem(result.items, "routing-degraded");
    expect(item?.severity).toBe("warning");
    expect(item?.app).toBeUndefined();
    expect(item?.message).toContain("boom");
  });

  test("disk usage below 80% produces no item", () => {
    const result = computePlatformHealth(baseInput({ diskUsage: { usedBytes: 70, totalBytes: 100 } }));
    expect(findItem(result.items, "disk-usage")).toBeUndefined();
  });

  test("disk usage at 80-89% is a warning", () => {
    const result = computePlatformHealth(baseInput({ diskUsage: { usedBytes: 85, totalBytes: 100 } }));
    expect(findItem(result.items, "disk-usage")?.severity).toBe("warning");
  });

  test("disk usage at 90%+ is critical", () => {
    const result = computePlatformHealth(baseInput({ diskUsage: { usedBytes: 92, totalBytes: 100 } }));
    expect(findItem(result.items, "disk-usage")?.severity).toBe("critical");
    expect(result.status).toBe("critical");
  });

  test("backup overdue produces a warning", () => {
    const now = 1_000_000_000_000;
    const result = computePlatformHealth(
      baseInput({
        autoBackup: { enabled: true, intervalHours: 24, lastRunAt: now - 25 * 3_600_000 },
        now: () => now
      })
    );
    expect(findItem(result.items, "backup-overdue")?.severity).toBe("warning");
  });

  test("backup within its interval produces no item", () => {
    const now = 1_000_000_000_000;
    const result = computePlatformHealth(
      baseInput({
        autoBackup: { enabled: true, intervalHours: 24, lastRunAt: now - 1 * 3_600_000 },
        now: () => now
      })
    );
    expect(findItem(result.items, "backup-overdue")).toBeUndefined();
  });

  test("backup enabled but never run produces a warning", () => {
    const result = computePlatformHealth(baseInput({ autoBackup: { enabled: true, intervalHours: 24, lastRunAt: null } }));
    expect(findItem(result.items, "backup-overdue")?.severity).toBe("warning");
  });

  test("backup disabled never produces an item, even if overdue by any measure", () => {
    const result = computePlatformHealth(baseInput({ autoBackup: { enabled: false, intervalHours: 24, lastRunAt: null } }));
    expect(findItem(result.items, "backup-overdue")).toBeUndefined();
  });

  test("memory over-commitment: ok/warning/critical thresholds", () => {
    const okApp = app({ id: 8, name: "a", memoryLimitMb: 100 });
    const warnApp = app({ id: 9, name: "b", memoryLimitMb: 7000 }); // ~85% of 8GiB
    const overApp = app({ id: 10, name: "c", memoryLimitMb: 9000 }); // over 8GiB

    expect(
      findItem(computePlatformHealth(baseInput({ storedAppsByName: new Map([["a", okApp]]) })).items, "memory-pressure")
    ).toBeUndefined();

    expect(
      findItem(computePlatformHealth(baseInput({ storedAppsByName: new Map([["b", warnApp]]) })).items, "memory-pressure")
        ?.severity
    ).toBe("warning");

    const overResult = computePlatformHealth(baseInput({ storedAppsByName: new Map([["c", overApp]]) }));
    expect(findItem(overResult.items, "memory-pressure")?.severity).toBe("critical");
    expect(overResult.status).toBe("critical");
  });

  test("CPU over-commitment: ok/warning/critical thresholds against dockerInfo.cpuCount", () => {
    // dockerInfo.cpuCount = 4 in CONNECTED_DOCKER.
    const okApp = app({ id: 11, name: "a", cpuLimit: 1 });
    const warnApp = app({ id: 12, name: "b", cpuLimit: 3.6 }); // 90% of 4 cores
    const overApp = app({ id: 13, name: "c", cpuLimit: 5 }); // over 4 cores

    expect(
      findItem(computePlatformHealth(baseInput({ storedAppsByName: new Map([["a", okApp]]) })).items, "cpu-pressure")
    ).toBeUndefined();

    expect(
      findItem(computePlatformHealth(baseInput({ storedAppsByName: new Map([["b", warnApp]]) })).items, "cpu-pressure")
        ?.severity
    ).toBe("warning");

    expect(
      findItem(computePlatformHealth(baseInput({ storedAppsByName: new Map([["c", overApp]]) })).items, "cpu-pressure")
        ?.severity
    ).toBe("critical");
  });

  test("overall status: critical beats warning beats healthy", () => {
    const critical = computePlatformHealth(baseInput({ diskUsage: { usedBytes: 99, totalBytes: 100 } }));
    expect(critical.status).toBe("critical");

    const warning = computePlatformHealth(
      baseInput({ storedAppsByName: new Map([["api", app({ id: 1, name: "api", health: { state: "unhealthy", lastCheckedAt: null } })]]) })
    );
    expect(warning.status).toBe("warning");

    const healthy = computePlatformHealth(baseInput());
    expect(healthy.status).toBe("healthy");
  });

  test("item ids are stable and unique across multiple apps in the same category", () => {
    const a = app({ id: 20, name: "a", health: { state: "unhealthy", lastCheckedAt: null } });
    const b = app({ id: 21, name: "b", health: { state: "unhealthy", lastCheckedAt: null } });
    const result = computePlatformHealth(
      baseInput({
        storedAppsByName: new Map([
          ["a", a],
          ["b", b]
        ])
      })
    );
    const ids = result.items.filter((item) => item.category === "unhealthy-app").map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("unhealthy-app:20");
    expect(ids).toContain("unhealthy-app:21");
  });
});
