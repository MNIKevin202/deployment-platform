import AppCard from "../components/AppCard";
import MissingAppCard from "../components/MissingAppCard";
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
  eyebrow = "Applications",
  title = "All Managed Apps",
  emptyTitle = "No managed apps yet",
  emptyBody = "Deploy your first application from a Docker image."
}: AppsPageProps) {
  const hasAnyApp = managedApps.length > 0 || missingApps.length > 0;

  return (
    <div className="page">
      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
          </div>

          <button className="primary-button compact" type="button" onClick={onCreateApp}>
            Create App
          </button>
        </div>

        {!hasAnyApp ? (
          <div className="empty-state app-empty-state">
            <h3>{emptyTitle}</h3>
            <p>{emptyBody}</p>
            <button className="primary-button" type="button" onClick={onCreateApp}>
              Deploy First App
            </button>
          </div>
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
