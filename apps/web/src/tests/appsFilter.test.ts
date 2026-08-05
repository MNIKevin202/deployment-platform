import { describe, expect, test } from "vitest";
import {
  matchesSearch,
  matchesFilters,
  filterAndSortAppEntries,
  type AppFilterKey,
  type AppListEntry
} from "../lib/appsFilter";
import type { ContainerSummary, StoredApp } from "../types/api";

function app(overrides: Partial<StoredApp> & { id: number; name: string }): StoredApp {
  return {
    image: "nginx:alpine",
    internalOnly: false,
    domain: null,
    lastDeployedAt: null,
    health: null,
    latestEventSeverity: null,
    latestEventType: null,
    routingReady: true,
    ...overrides
  } as StoredApp;
}

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: `c-${Math.random().toString(16).slice(2)}`,
    shortId: "abc123",
    names: ["/worker"],
    image: "nginx:alpine",
    state: "running",
    status: "Up 2 minutes",
    created: 0,
    ports: [],
    labels: {},
    isSystemContainer: false,
    isManagedApp: true,
    ...overrides
  } as ContainerSummary;
}

describe("matchesSearch", () => {
  test("empty query matches everything", () => {
    expect(matchesSearch({ app: app({ id: 1, name: "worker" }) }, "")).toBe(true);
  });

  test("matches by app name, case-insensitive", () => {
    expect(matchesSearch({ app: app({ id: 1, name: "Worker" }) }, "work")).toBe(true);
    expect(matchesSearch({ app: app({ id: 1, name: "Worker" }) }, "xyz")).toBe(false);
  });

  test("matches by image when name doesn't match", () => {
    const entry: AppListEntry = { app: app({ id: 1, name: "api", image: "myorg/custom-image:latest" }) };
    expect(matchesSearch(entry, "custom-image")).toBe(true);
  });

  test("falls back to the container name when there is no stored app", () => {
    const entry: AppListEntry = { container: container({ names: ["/orphan-container"] }) };
    expect(matchesSearch(entry, "orphan")).toBe(true);
  });
});

describe("matchesFilters", () => {
  const now = () => 1_000_000_000_000;

  test("no active filters matches everything", () => {
    const entry: AppListEntry = { app: app({ id: 1, name: "a" }) };
    expect(matchesFilters(entry, new Set(), new Set(), now)).toBe(true);
  });

  test("running vs stopped", () => {
    const runningEntry: AppListEntry = { app: app({ id: 1, name: "a" }), container: container({ state: "running" }) };
    const stoppedEntry: AppListEntry = { app: app({ id: 2, name: "b" }), container: container({ state: "exited" }) };

    expect(matchesFilters(runningEntry, new Set(["running"]), new Set(), now)).toBe(true);
    expect(matchesFilters(stoppedEntry, new Set(["running"]), new Set(), now)).toBe(false);
    expect(matchesFilters(stoppedEntry, new Set(["stopped"]), new Set(), now)).toBe(true);
    expect(matchesFilters(runningEntry, new Set(["stopped"]), new Set(), now)).toBe(false);
  });

  test("a missing app (no container) counts as stopped", () => {
    const missingEntry: AppListEntry = { app: app({ id: 1, name: "a" }) };
    expect(matchesFilters(missingEntry, new Set(["stopped"]), new Set(), now)).toBe(true);
    expect(matchesFilters(missingEntry, new Set(["running"]), new Set(), now)).toBe(false);
  });

  test("public vs internal", () => {
    const publicEntry: AppListEntry = { app: app({ id: 1, name: "a", internalOnly: false }) };
    const internalEntry: AppListEntry = { app: app({ id: 2, name: "b", internalOnly: true }) };

    expect(matchesFilters(publicEntry, new Set(["public"]), new Set(), now)).toBe(true);
    expect(matchesFilters(internalEntry, new Set(["public"]), new Set(), now)).toBe(false);
    expect(matchesFilters(internalEntry, new Set(["internal"]), new Set(), now)).toBe(true);
    expect(matchesFilters(publicEntry, new Set(["internal"]), new Set(), now)).toBe(false);
  });

  test("healthy", () => {
    const healthy: AppListEntry = { app: app({ id: 1, name: "a", health: { state: "healthy", lastCheckedAt: null } }) };
    const unhealthy: AppListEntry = { app: app({ id: 2, name: "b", health: { state: "unhealthy", lastCheckedAt: null } }) };

    expect(matchesFilters(healthy, new Set(["healthy"]), new Set(), now)).toBe(true);
    expect(matchesFilters(unhealthy, new Set(["healthy"]), new Set(), now)).toBe(false);
  });

  test("failed — only matches known deploy-failure event types with error severity", () => {
    const failed: AppListEntry = {
      app: app({ id: 1, name: "a", latestEventSeverity: "error", latestEventType: "github-deploy-failed" })
    };
    const unrelatedError: AppListEntry = {
      app: app({ id: 2, name: "b", latestEventSeverity: "error", latestEventType: "health-check-error" })
    };

    expect(matchesFilters(failed, new Set(["failed"]), new Set(), now)).toBe(true);
    expect(matchesFilters(unrelatedError, new Set(["failed"]), new Set(), now)).toBe(false);
  });

  test("recent — within vs outside the 24h window", () => {
    const nowMs = now();
    const withinWindow: AppListEntry = {
      app: app({ id: 1, name: "a", lastDeployedAt: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString() })
    };
    const outsideWindow: AppListEntry = {
      app: app({ id: 2, name: "b", lastDeployedAt: new Date(nowMs - 25 * 60 * 60 * 1000).toISOString() })
    };
    const neverDeployed: AppListEntry = { app: app({ id: 3, name: "c", lastDeployedAt: null }) };

    expect(matchesFilters(withinWindow, new Set(["recent"]), new Set(), now)).toBe(true);
    expect(matchesFilters(outsideWindow, new Set(["recent"]), new Set(), now)).toBe(false);
    expect(matchesFilters(neverDeployed, new Set(["recent"]), new Set(), now)).toBe(false);
  });

  test("favorites", () => {
    const favorited: AppListEntry = { app: app({ id: 1, name: "a" }) };
    const notFavorited: AppListEntry = { app: app({ id: 2, name: "b" }) };
    const favoriteIds = new Set([1]);

    expect(matchesFilters(favorited, new Set(["favorites"]), favoriteIds, now)).toBe(true);
    expect(matchesFilters(notFavorited, new Set(["favorites"]), favoriteIds, now)).toBe(false);
  });

  test("multiple active filters are ANDed", () => {
    const runningPublicHealthy: AppListEntry = {
      app: app({ id: 1, name: "a", internalOnly: false, health: { state: "healthy", lastCheckedAt: null } }),
      container: container({ state: "running" })
    };
    const runningInternalHealthy: AppListEntry = {
      app: app({ id: 2, name: "b", internalOnly: true, health: { state: "healthy", lastCheckedAt: null } }),
      container: container({ state: "running" })
    };

    const filters: Set<AppFilterKey> = new Set(["running", "public", "healthy"]);
    expect(matchesFilters(runningPublicHealthy, filters, new Set(), now)).toBe(true);
    expect(matchesFilters(runningInternalHealthy, filters, new Set(), now)).toBe(false);
  });
});

describe("filterAndSortAppEntries", () => {
  test("favorited entries always sort before non-favorited ones, regardless of sort key", () => {
    const entries: AppListEntry[] = [
      { app: app({ id: 1, name: "zeta" }), container: container() },
      { app: app({ id: 2, name: "alpha" }), container: container() } // favorited, but alphabetically last
    ];

    const result = filterAndSortAppEntries(entries, {
      search: "",
      filters: new Set(),
      sortKey: "name",
      favoriteIds: new Set([2])
    });

    expect(result.map((entry) => entry.app?.name)).toEqual(["alpha", "zeta"]);
  });

  test("sorts by name within each group", () => {
    const entries: AppListEntry[] = [
      { app: app({ id: 1, name: "zeta" }), container: container() },
      { app: app({ id: 2, name: "alpha" }), container: container() }
    ];

    const result = filterAndSortAppEntries(entries, {
      search: "",
      filters: new Set(),
      sortKey: "name",
      favoriteIds: new Set()
    });

    expect(result.map((entry) => entry.app?.name)).toEqual(["alpha", "zeta"]);
  });

  test("sorts by most recently deployed first", () => {
    const older = new Date(1000).toISOString();
    const newer = new Date(2000).toISOString();
    const entries: AppListEntry[] = [
      { app: app({ id: 1, name: "old-app", lastDeployedAt: older }), container: container() },
      { app: app({ id: 2, name: "new-app", lastDeployedAt: newer }), container: container() }
    ];

    const result = filterAndSortAppEntries(entries, {
      search: "",
      filters: new Set(),
      sortKey: "recent-deploy",
      favoriteIds: new Set()
    });

    expect(result.map((entry) => entry.app?.name)).toEqual(["new-app", "old-app"]);
  });

  test("sorts running apps before stopped apps under the status sort", () => {
    const entries: AppListEntry[] = [
      { app: app({ id: 1, name: "stopped-app" }), container: container({ state: "exited" }) },
      { app: app({ id: 2, name: "running-app" }), container: container({ state: "running" }) }
    ];

    const result = filterAndSortAppEntries(entries, {
      search: "",
      filters: new Set(),
      sortKey: "status",
      favoriteIds: new Set()
    });

    expect(result.map((entry) => entry.app?.name)).toEqual(["running-app", "stopped-app"]);
  });

  test("combines search, filters, and sort together", () => {
    const entries: AppListEntry[] = [
      { app: app({ id: 1, name: "web-frontend" }), container: container({ state: "running", image: "myorg/web:latest" }) },
      { app: app({ id: 2, name: "web-backend" }), container: container({ state: "exited", image: "myorg/web:latest" }) },
      { app: app({ id: 3, name: "database" }), container: container({ state: "running", image: "postgres:16" }) }
    ];

    const result = filterAndSortAppEntries(entries, {
      search: "web",
      filters: new Set(["running"]),
      sortKey: "name",
      favoriteIds: new Set()
    });

    expect(result.map((entry) => entry.app?.name)).toEqual(["web-frontend"]);
  });
});
