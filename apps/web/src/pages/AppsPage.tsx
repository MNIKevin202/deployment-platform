import { useState } from "react";
import AppCard from "../components/AppCard";
import MissingAppCard from "../components/MissingAppCard";
import AppTable from "../components/AppTable";
import { useAppsView } from "../hooks/useAppsView";
import { useFavoriteApps } from "../hooks/useFavoriteApps";
import {
  filterAndSortAppEntries,
  type AppFilterKey,
  type AppListEntry,
  type AppSortKey
} from "../lib/appsFilter";
import type {
  ContainerAction,
  ContainerSummary,
  StoredApp
} from "../types/api";

const FILTER_OPTIONS: { key: AppFilterKey; label: string }[] = [
  { key: "favorites", label: "Favorites" },
  { key: "running", label: "Running" },
  { key: "stopped", label: "Stopped" },
  { key: "public", label: "Public" },
  { key: "internal", label: "Internal" },
  { key: "healthy", label: "Healthy" },
  { key: "failed", label: "Failed" },
  { key: "recent", label: "Recently deployed" }
];

const SORT_OPTIONS: { key: AppSortKey; label: string }[] = [
  { key: "name", label: "Name (A–Z)" },
  { key: "recent-deploy", label: "Last deployed" },
  { key: "status", label: "Status" }
];

interface AppsPageProps {
  managedApps: ContainerSummary[];
  storedAppsByName: Map<string, StoredApp>;
  missingApps: StoredApp[];
  actionLoading: string | null;
  onAction: (container: ContainerSummary, action: ContainerAction) => void;
  onOpenLogs: (container: ContainerSummary) => void;
  onDeleteApp: (container: ContainerSummary) => void;
  onDeleteMissingApp: (storedApp: StoredApp) => void;
  onViewApp: (storedApp: StoredApp) => void;
  onCreateApp: () => void;
  onBrowseTemplates?: () => void;
  onUpdateAll?: (managedApps: ContainerSummary[]) => void;
  updateAllLoading?: boolean;
  /** Heading + empty-state copy, so the same list serves both Apps and Databases. */
  eyebrow?: string;
  title?: string;
  emptyTitle?: string;
  emptyBody?: string;
}

export default function AppsPage({
  managedApps,
  storedAppsByName,
  missingApps,
  actionLoading,
  onAction,
  onOpenLogs,
  onDeleteApp,
  onDeleteMissingApp,
  onViewApp,
  onCreateApp,
  onBrowseTemplates,
  onUpdateAll,
  updateAllLoading = false,
  eyebrow = "Applications",
  title = "All Managed Apps",
  emptyTitle = "No managed apps yet",
  emptyBody = "Deploy your first application from a Docker image."
}: AppsPageProps) {
  const hasAnyApp = managedApps.length > 0 || missingApps.length > 0;
  const [view, setView] = useAppsView();
  const [favoriteAppIds, toggleFavorite] = useFavoriteApps();
  const [search, setSearch] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<AppFilterKey>>(() => new Set());
  const [sortKey, setSortKey] = useState<AppSortKey>("name");

  const toggleFilter = (key: AppFilterKey) => {
    setActiveFilters((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const updatesAvailableCount = managedApps.filter((container) => {
    const appName = container.labels["com.deployment-platform.app-name"];
    const storedApp = appName ? storedAppsByName.get(appName) : undefined;
    return Boolean(storedApp?.imageUpdateAvailable);
  }).length;

  // Managed (running/stopped) and missing (recovery-needed) apps are filtered
  // and sorted as two separate groups — missing apps stay their own
  // visually-distinct "needs recovery" tier at the bottom of each view,
  // rather than being interleaved with live containers.
  const managedEntries: AppListEntry[] = managedApps.map((container) => {
    const appName = container.labels["com.deployment-platform.app-name"];
    return { container, app: appName ? storedAppsByName.get(appName) : undefined };
  });
  const missingEntries: AppListEntry[] = missingApps.map((app) => ({ app }));

  const filterOptions = { search, filters: activeFilters, sortKey, favoriteIds: favoriteAppIds };
  const filteredManagedContainers = filterAndSortAppEntries(managedEntries, filterOptions)
    .map((entry) => entry.container)
    .filter((container): container is ContainerSummary => container !== undefined);
  const filteredMissingApps = filterAndSortAppEntries(missingEntries, filterOptions)
    .map((entry) => entry.app)
    .filter((app): app is StoredApp => app !== undefined);

  return (
    <div className="page">
      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
          </div>

          <div className="section-heading-actions">
            {hasAnyApp && (
              <div className="view-toggle" role="group" aria-label="Layout">
                <button
                  type="button"
                  className={view === "grid" ? "active" : ""}
                  aria-pressed={view === "grid"}
                  onClick={() => setView("grid")}
                >
                  ▦ Grid
                </button>
                <button
                  type="button"
                  className={view === "table" ? "active" : ""}
                  aria-pressed={view === "table"}
                  onClick={() => setView("table")}
                >
                  ▤ Table
                </button>
              </div>
            )}

            {onBrowseTemplates && (
              <button className="secondary-button compact" type="button" onClick={onBrowseTemplates}>
                Templates
              </button>
            )}

            {onUpdateAll && updatesAvailableCount > 0 && (
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => onUpdateAll(managedApps)}
                disabled={updateAllLoading}
              >
                {updateAllLoading ? "Updating..." : `Update All (${updatesAvailableCount})`}
              </button>
            )}

            <button className="primary-button compact" type="button" onClick={onCreateApp}>
              Create App
            </button>
          </div>
        </div>

        {hasAnyApp && (
          <div className="apps-filter-row">
            <input
              className="apps-filter-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or image..."
              aria-label="Search apps"
            />
            <div className="apps-filter-chips" role="group" aria-label="Filters">
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={`apps-filter-chip ${activeFilters.has(option.key) ? "active" : ""}`}
                  aria-pressed={activeFilters.has(option.key)}
                  onClick={() => toggleFilter(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <select
              className="apps-filter-sort"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as AppSortKey)}
              aria-label="Sort apps"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  Sort: {option.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {!hasAnyApp ? (
          <div className="empty-state app-empty-state">
            <h3>{emptyTitle}</h3>
            <p>{emptyBody}</p>
            <button className="primary-button" type="button" onClick={onCreateApp}>
              Deploy First App
            </button>
          </div>
        ) : filteredManagedContainers.length === 0 && filteredMissingApps.length === 0 ? (
          <div className="empty-state">
            <h3>No apps match your search or filters</h3>
            <p>Try clearing the search box or turning off a filter.</p>
          </div>
        ) : view === "table" ? (
          <AppTable
            managedApps={filteredManagedContainers}
            storedAppsByName={storedAppsByName}
            missingApps={filteredMissingApps}
            actionLoading={actionLoading}
            onAction={onAction}
            onOpenLogs={onOpenLogs}
            onDeleteApp={onDeleteApp}
            onDeleteMissingApp={onDeleteMissingApp}
            onViewApp={onViewApp}
            favoriteAppIds={favoriteAppIds}
            onToggleFavorite={toggleFavorite}
          />
        ) : (
          <div className="container-grid">
            {filteredManagedContainers.map((container) => {
              const appName = container.labels["com.deployment-platform.app-name"];
              const storedApp = appName ? storedAppsByName.get(appName) : undefined;

              return (
                <AppCard
                  key={container.id}
                  container={container}
                  storedApp={storedApp}
                  actionLoading={actionLoading}
                  onAction={onAction}
                  onOpenLogs={onOpenLogs}
                  onDeleteApp={onDeleteApp}
                  onViewApp={onViewApp}
                  isFavorite={Boolean(storedApp && favoriteAppIds.has(storedApp.id))}
                  onToggleFavorite={toggleFavorite}
                />
              );
            })}

            {filteredMissingApps.map((storedApp) => (
              <MissingAppCard
                key={`missing-${storedApp.id}`}
                storedApp={storedApp}
                actionLoading={actionLoading}
                onViewApp={onViewApp}
                onDeleteApp={onDeleteMissingApp}
                isFavorite={favoriteAppIds.has(storedApp.id)}
                onToggleFavorite={toggleFavorite}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
