import AppCard from "../components/AppCard";
import MissingAppCard from "../components/MissingAppCard";
import AppTable from "../components/AppTable";
import { useAppsView } from "../hooks/useAppsView";
import type {
  ContainerAction,
  ContainerSummary,
  StoredApp
} from "../types/api";

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

  const updatesAvailableCount = managedApps.filter((container) => {
    const appName = container.labels["com.deployment-platform.app-name"];
    const storedApp = appName ? storedAppsByName.get(appName) : undefined;
    return Boolean(storedApp?.imageUpdateAvailable);
  }).length;

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

        {!hasAnyApp ? (
          <div className="empty-state app-empty-state">
            <h3>{emptyTitle}</h3>
            <p>{emptyBody}</p>
            <button className="primary-button" type="button" onClick={onCreateApp}>
              Deploy First App
            </button>
          </div>
        ) : view === "table" ? (
          <AppTable
            managedApps={managedApps}
            storedAppsByName={storedAppsByName}
            missingApps={missingApps}
            actionLoading={actionLoading}
            onAction={onAction}
            onOpenLogs={onOpenLogs}
            onDeleteApp={onDeleteApp}
            onDeleteMissingApp={onDeleteMissingApp}
            onViewApp={onViewApp}
          />
        ) : (
          <div className="container-grid">
            {managedApps.map((container) => {
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
                />
              );
            })}

            {missingApps.map((storedApp) => (
              <MissingAppCard
                key={`missing-${storedApp.id}`}
                storedApp={storedApp}
                actionLoading={actionLoading}
                onViewApp={onViewApp}
                onDeleteApp={onDeleteMissingApp}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
