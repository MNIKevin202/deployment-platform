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
  onCreateApp
}: AppsPageProps) {
  const hasAnyApp = managedApps.length > 0 || missingApps.length > 0;

  return (
    <div className="page">
      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Applications</p>
            <h2>All Managed Apps</h2>
          </div>

          <button className="primary-button compact" type="button" onClick={onCreateApp}>
            Create App
          </button>
        </div>

        {!hasAnyApp ? (
          <div className="empty-state app-empty-state">
            <h3>No managed apps yet</h3>
            <p>Deploy your first application from a Docker image.</p>
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
