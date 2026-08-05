import { DEPLOY_FAILURE_EVENT_TYPES } from "./platformHealth";
import type { ContainerSummary, StoredApp } from "../types/api";

export type AppFilterKey =
  | "running"
  | "stopped"
  | "public"
  | "internal"
  | "healthy"
  | "failed"
  | "recent"
  | "favorites";

export type AppSortKey = "name" | "recent-deploy" | "status";

/** One row in the Apps list — a running/stopped app has both; a missing (recovery-needed) app has only `app`. */
export interface AppListEntry {
  app?: StoredApp;
  container?: ContainerSummary;
}

/** How recent a deployment must be to count as "Recently deployed". */
const RECENT_DEPLOY_WINDOW_MS = 24 * 60 * 60 * 1000;

function entryName(entry: AppListEntry): string {
  return entry.app?.name ?? entry.container?.names[0]?.replace(/^\//, "") ?? "";
}

function entryImage(entry: AppListEntry): string {
  return entry.app?.image ?? entry.container?.image ?? "";
}

export function matchesSearch(entry: AppListEntry, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") {
    return true;
  }
  return entryName(entry).toLowerCase().includes(trimmed) || entryImage(entry).toLowerCase().includes(trimmed);
}

/**
 * A container-less entry (a "missing" app awaiting recovery) is never
 * running, so it counts toward "Stopped" the same way an exited container
 * would.
 */
function isRunning(entry: AppListEntry): boolean {
  return entry.container?.state === "running";
}

function isFailed(entry: AppListEntry): boolean {
  const app = entry.app;
  return Boolean(
    app?.latestEventSeverity === "error" && app.latestEventType && DEPLOY_FAILURE_EVENT_TYPES.has(app.latestEventType)
  );
}

function isHealthy(entry: AppListEntry): boolean {
  return entry.app?.health?.state === "healthy";
}

function isRecent(entry: AppListEntry, now: () => number): boolean {
  const lastDeployedAt = entry.app?.lastDeployedAt;
  if (!lastDeployedAt) {
    return false;
  }
  const parsed = new Date(lastDeployedAt).getTime();
  return !Number.isNaN(parsed) && now() - parsed <= RECENT_DEPLOY_WINDOW_MS;
}

/** All active filters are ANDed together — a deliberately simple model with no facet grouping. */
export function matchesFilters(
  entry: AppListEntry,
  filters: ReadonlySet<AppFilterKey>,
  favoriteIds: ReadonlySet<number>,
  now: () => number = () => Date.now()
): boolean {
  for (const filter of filters) {
    switch (filter) {
      case "running":
        if (!isRunning(entry)) return false;
        break;
      case "stopped":
        if (isRunning(entry)) return false;
        break;
      case "public":
        if (!entry.app || entry.app.internalOnly) return false;
        break;
      case "internal":
        if (!entry.app?.internalOnly) return false;
        break;
      case "healthy":
        if (!isHealthy(entry)) return false;
        break;
      case "failed":
        if (!isFailed(entry)) return false;
        break;
      case "recent":
        if (!isRecent(entry, now)) return false;
        break;
      case "favorites":
        if (!entry.app || !favoriteIds.has(entry.app.id)) return false;
        break;
    }
  }
  return true;
}

function compareBySortKey(a: AppListEntry, b: AppListEntry, sortKey: AppSortKey): number {
  switch (sortKey) {
    case "name":
      return entryName(a).localeCompare(entryName(b));
    case "recent-deploy": {
      const aTime = a.app?.lastDeployedAt ? new Date(a.app.lastDeployedAt).getTime() : -Infinity;
      const bTime = b.app?.lastDeployedAt ? new Date(b.app.lastDeployedAt).getTime() : -Infinity;
      return bTime - aTime; // newest first
    }
    case "status": {
      // Running before stopped/missing; alphabetical within each.
      const aRunning = isRunning(a) ? 0 : 1;
      const bRunning = isRunning(b) ? 0 : 1;
      return aRunning !== bRunning ? aRunning - bRunning : entryName(a).localeCompare(entryName(b));
    }
  }
}

export interface FilterAndSortOptions {
  search: string;
  filters: ReadonlySet<AppFilterKey>;
  sortKey: AppSortKey;
  favoriteIds: ReadonlySet<number>;
  now?: () => number;
}

/**
 * Filters, then sorts, an entry list — favorited entries always lead
 * (stable), with the chosen sort applied within the favorite and
 * non-favorite groups separately, so pinning always wins over any other
 * ordering.
 */
export function filterAndSortAppEntries(entries: AppListEntry[], options: FilterAndSortOptions): AppListEntry[] {
  const now = options.now ?? (() => Date.now());

  const filtered = entries.filter(
    (entry) => matchesSearch(entry, options.search) && matchesFilters(entry, options.filters, options.favoriteIds, now)
  );

  const favorited = filtered.filter((entry) => entry.app && options.favoriteIds.has(entry.app.id));
  const rest = filtered.filter((entry) => !entry.app || !options.favoriteIds.has(entry.app.id));

  favorited.sort((a, b) => compareBySortKey(a, b, options.sortKey));
  rest.sort((a, b) => compareBySortKey(a, b, options.sortKey));

  return [...favorited, ...rest];
}
