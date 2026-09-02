import { useEffect, useMemo, useState } from "react";
import AppCard from "../components/AppCard";
import MissingAppCard from "../components/MissingAppCard";
import AppTable from "../components/AppTable";
import { useAppsView } from "../hooks/useAppsView";
import { useFavoriteApps } from "../hooks/useFavoriteApps";
import {
  filterAndSortAppEntries,
  matchesFilters,
  type AppFilterKey,
  type AppListEntry,
  type AppSortKey
} from "../lib/appsFilter";
import type {
  ContainerAction,
  ContainerSummary,
  StoredApp
} from "../types/api";
import { appSelectionKey, containerSelectionKey } from "../lib/appSelection";
import { isDatabaseImage } from "../lib/appKind";

type AppTypeFilter = "all" | "services" | "databases";

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
  onBulkAction?: (
    containers: ContainerSummary[],
    action: "start" | "stop"
  ) => Promise<boolean>;
  onBulkDelete?: (
    containers: ContainerSummary[],
    missingApps: StoredApp[]
  ) => Promise<boolean>;
  /** Heading + empty-state copy, so the same list serves both Apps and Databases. */
  eyebrow?: string;
  title?: string;
  emptyTitle?: string;
  emptyBody?: string;
  /** Preselects the Type facet — e.g. a legacy ?section=databases deep link. */
  initialType?: AppTypeFilter;
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
  onBulkAction,
  onBulkDelete,
  eyebrow = "Applications",
  title = "All Managed Apps",
  emptyTitle = "No managed apps yet",
  emptyBody = "Deploy your first application from a Docker image.",
  initialType = "all"
}: AppsPageProps) {
  const hasAnyApp = managedApps.length > 0 || missingApps.length > 0;
  const [typeFilter, setTypeFilter] = useState<AppTypeFilter>(initialType);

  // Type is a facet, not one of the AND-ed status chips — services and
  // databases are mutually exclusive, so it pre-filters the list before the
  // status filters apply. Memoized so the arrays stay referentially stable
  // (the selection-clearing effect below depends on them).
  const typedManaged = useMemo(
    () =>
      managedApps.filter((container) =>
        typeFilter === "all"
          ? true
          : (typeFilter === "databases") === isDatabaseImage(container.image)
      ),
    [managedApps, typeFilter]
  );
  const typedMissing = useMemo(
    () =>
      missingApps.filter((app) =>
        typeFilter === "all"
          ? true
          : (typeFilter === "databases") === isDatabaseImage(app.image)
      ),
    [missingApps, typeFilter]
  );

  const databaseCount = useMemo(
    () =>
      [...managedApps.map((c) => c.image), ...missingApps.map((a) => a.image)].filter(
        isDatabaseImage
      ).length,
    [managedApps, missingApps]
  );
  const serviceCount = managedApps.length + missingApps.length - databaseCount;
  const typeOptions: { key: AppTypeFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: serviceCount + databaseCount },
    { key: "services", label: "Services", count: serviceCount },
    { key: "databases", label: "Databases", count: databaseCount }
  ];

  const [view, setView] = useAppsView();
  const [favoriteAppIds, toggleFavorite] = useFavoriteApps();
  const [search, setSearch] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<AppFilterKey>>(() => new Set());
  const [sortKey, setSortKey] = useState<AppSortKey>("name");
  const [selectedAppKeys, setSelectedAppKeys] = useState<Set<string>>(() => new Set());

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

  const updatesAvailableCount = typedManaged.filter((container) => {
    const appName = container.labels["com.deployment-platform.app-name"];
    const storedApp = appName ? storedAppsByName.get(appName) : undefined;
    return Boolean(storedApp?.imageUpdateAvailable);
  }).length;

  // Managed (running/stopped) and missing (recovery-needed) apps are filtered
  // and sorted as two separate groups — missing apps stay their own
  // visually-distinct "needs recovery" tier at the bottom of each view,
  // rather than being interleaved with live containers.
  const managedEntries: AppListEntry[] = typedManaged.map((container) => {
    const appName = container.labels["com.deployment-platform.app-name"];
    return { container, app: appName ? storedAppsByName.get(appName) : undefined };
  });
  const missingEntries: AppListEntry[] = typedMissing.map((app) => ({ app }));

  const filterOptions = { search, filters: activeFilters, sortKey, favoriteIds: favoriteAppIds };
  const filteredManagedContainers = filterAndSortAppEntries(managedEntries, filterOptions)
    .map((entry) => entry.container)
    .filter((container): container is ContainerSummary => container !== undefined);
  const filteredMissingApps = filterAndSortAppEntries(missingEntries, filterOptions)
    .map((entry) => entry.app)
    .filter((app): app is StoredApp => app !== undefined);

  const managedSelection = typedManaged.map((container) => {
    const appName = container.labels["com.deployment-platform.app-name"];
    const storedApp = appName ? storedAppsByName.get(appName) : undefined;
    return { key: containerSelectionKey(container, storedApp), container };
  });
  const missingSelection = typedMissing.map((app) => ({ key: appSelectionKey(app), app }));
  const selectedContainers = managedSelection
    .filter((entry) => selectedAppKeys.has(entry.key))
    .map((entry) => entry.container);
  const selectedMissingApps = missingSelection
    .filter((entry) => selectedAppKeys.has(entry.key))
    .map((entry) => entry.app);
  const selectedCount = selectedContainers.length + selectedMissingApps.length;
  const startableContainers = selectedContainers.filter(
    (container) => container.state !== "running"
  );
  const stoppableContainers = selectedContainers.filter(
    (container) => container.state === "running"
  );
  const bulkBusy = actionLoading !== null;

  useEffect(() => {
    const validKeys = new Set([
      ...managedSelection.map((entry) => entry.key),
      ...missingSelection.map((entry) => entry.key)
    ]);
    setSelectedAppKeys((previous) => {
      const next = new Set([...previous].filter((key) => validKeys.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [typedManaged, typedMissing, storedAppsByName]);

  const toggleSelected = (key: string) => {
    setSelectedAppKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const visibleSelectionKeys = [
    ...filteredManagedContainers.map((container) => {
      const appName = container.labels["com.deployment-platform.app-name"];
      return containerSelectionKey(
        container,
        appName ? storedAppsByName.get(appName) : undefined
      );
    }),
    ...filteredMissingApps.map(appSelectionKey)
  ];

  const toggleAllVisible = () => {
    setSelectedAppKeys((previous) => {
      const next = new Set(previous);
      const allSelected = visibleSelectionKeys.every((key) => next.has(key));
      for (const key of visibleSelectionKeys) {
        if (allSelected) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
  };

  const runBulkAction = async (action: "start" | "stop") => {
    const containers = action === "start" ? startableContainers : stoppableContainers;
    if (!onBulkAction || containers.length === 0) {
      return;
    }
    if (await onBulkAction(containers, action)) {
      setSelectedAppKeys(new Set());
    }
  };

  const runBulkDelete = async () => {
    if (!onBulkDelete || selectedCount === 0) {
      return;
    }
    if (await onBulkDelete(selectedContainers, selectedMissingApps)) {
      setSelectedAppKeys(new Set());
    }
  };

  // Each pill's count reflects the full (unfiltered-by-other-pills) set, so
  // toggling one filter doesn't make the others' counts shift underneath it —
  // "how many apps match this facet", not "how many remain if combined".
  const allEntries = [...managedEntries, ...missingEntries];
  const filterCounts = new Map<AppFilterKey, number>(
    FILTER_OPTIONS.map((option) => [
      option.key,
      allEntries.filter((entry) => matchesFilters(entry, new Set([option.key]), favoriteAppIds)).length
    ])
  );
  const hasActiveFilters = activeFilters.size > 0 || search !== "";
  const clearFilters = () => {
    setActiveFilters(new Set());
    setSearch("");
  };

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
                onClick={() => onUpdateAll(typedManaged)}
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
          <>
            <div className="apps-filter-row">
              <input
                className="apps-filter-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name or image..."
                aria-label="Search apps"
              />
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
              <span className="apps-filter-count text-faint">
                {filteredManagedContainers.length + filteredMissingApps.length} app
                {filteredManagedContainers.length + filteredMissingApps.length === 1 ? "" : "s"}
              </span>
            </div>

            <div className="apps-filter-pill-row">
              {databaseCount > 0 && (
                <div
                  className="apps-filter-chips apps-type-facet"
                  role="group"
                  aria-label="App type"
                >
                  {typeOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={`apps-filter-chip ${typeFilter === option.key ? "active" : ""}`}
                      aria-pressed={typeFilter === option.key}
                      onClick={() => setTypeFilter(option.key)}
                    >
                      {option.label}{" "}
                      <span className="apps-filter-chip-count">{option.count}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="apps-filter-chips" role="group" aria-label="Filters">
                <button
                  type="button"
                  className={`apps-filter-chip ${activeFilters.size === 0 ? "active" : ""}`}
                  aria-pressed={activeFilters.size === 0}
                  onClick={() => setActiveFilters(new Set())}
                >
                  All <span className="apps-filter-chip-count">{allEntries.length}</span>
                </button>
                {FILTER_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={`apps-filter-chip ${activeFilters.has(option.key) ? "active" : ""}`}
                    aria-pressed={activeFilters.has(option.key)}
                    onClick={() => toggleFilter(option.key)}
                  >
                    {option.label} <span className="apps-filter-chip-count">{filterCounts.get(option.key)}</span>
                  </button>
                ))}
              </div>
              {hasActiveFilters && (
                <button type="button" className="apps-filter-clear" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>

            {selectedCount > 0 && onBulkAction && onBulkDelete && (
              <div className="apps-bulk-actions" role="toolbar" aria-label="Bulk app actions">
                <strong>
                  {selectedCount} app{selectedCount === 1 ? "" : "s"} selected
                </strong>
                <div className="apps-bulk-action-buttons">
                  <button
                    className="primary-button compact"
                    type="button"
                    disabled={bulkBusy || startableContainers.length === 0}
                    onClick={() => void runBulkAction("start")}
                  >
                    Start ({startableContainers.length})
                  </button>
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={bulkBusy || stoppableContainers.length === 0}
                    onClick={() => void runBulkAction("stop")}
                  >
                    Stop ({stoppableContainers.length})
                  </button>
                  <button
                    className="danger-button compact"
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => void runBulkDelete()}
                  >
                    Delete ({selectedCount})
                  </button>
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => setSelectedAppKeys(new Set())}
                  >
                    Clear selection
                  </button>
                </div>
              </div>
            )}
          </>
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
            selectedAppKeys={selectedAppKeys}
            onToggleSelected={toggleSelected}
            onToggleAllVisible={toggleAllVisible}
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
                  selected={selectedAppKeys.has(containerSelectionKey(container, storedApp))}
                  onToggleSelected={() =>
                    toggleSelected(containerSelectionKey(container, storedApp))
                  }
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
                selected={selectedAppKeys.has(appSelectionKey(storedApp))}
                onToggleSelected={() => toggleSelected(appSelectionKey(storedApp))}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
