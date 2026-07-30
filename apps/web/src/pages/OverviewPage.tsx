import StatCard from "../components/StatCard";
import AppCard from "../components/AppCard";
import AppTable from "../components/AppTable";
import { useAppsView } from "../hooks/useAppsView";
import { isDatabaseImage } from "../lib/appKind";
import type {
  ContainerAction,
  ContainerSummary,
  DockerInfo,
  RoutingStatus,
  StoredApp
} from "../types/api";

interface OverviewPageProps {
  dockerInfo: DockerInfo | null;
  routingStatus: RoutingStatus | null;
  managedApps: ContainerSummary[];
  storedAppsByName: Map<string, StoredApp>;
  actionLoading: string | null;
  onAction: (container: ContainerSummary, action: ContainerAction) => void;
  onOpenLogs: (container: ContainerSummary) => void;
  onDeleteApp: (container: ContainerSummary) => void;
  onViewApp: (storedApp: StoredApp) => void;
  onCreateApp: () => void;
}

function formatMemory(bytes: number): string {
  if (!bytes) {
    return "Unknown";
  }

  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(1)} GB`;
}

function routingHealthLabel(status: RoutingStatus | null): {
  label: string;
  tone: "positive" | "negative" | "neutral" | "warning";
} {
  if (!status || !status.enabled) {
    return { label: "Disabled", tone: "neutral" };
  }

  if (status.lastReconcileSucceeded === true) {
    return { label: "Healthy", tone: "positive" };
  }

  if (status.lastReconcileSucceeded === false) {
    return { label: "Degraded", tone: "negative" };
  }

  return { label: "Unknown", tone: "warning" };
}

export default function OverviewPage({
  dockerInfo,
  routingStatus,
  managedApps,
  storedAppsByName,
  actionLoading,
  onAction,
  onOpenLogs,
  onDeleteApp,
  onViewApp,
  onCreateApp
}: OverviewPageProps) {
  const serviceApps = managedApps.filter((c) => !isDatabaseImage(c.image));
  const databaseApps = managedApps.filter((c) => isDatabaseImage(c.image));
  const [view, setView] = useAppsView();
  const runningCount = managedApps.filter((c) => c.state === "running").length;
  const stoppedCount = managedApps.length - runningCount;
  const routingHealth = routingHealthLabel(routingStatus);

  return (
    <div className="page">
      <section className="stats-grid">
        <StatCard label="Apps" value={String(serviceApps.length)} />
        <StatCard label="Databases" value={String(databaseApps.length)} />
        <StatCard label="Running" value={String(runningCount)} tone="positive" />
        <StatCard label="Stopped" value={String(stoppedCount)} tone={stoppedCount > 0 ? "warning" : "neutral"} />
        <StatCard
          label="Routing"
          value={routingHealth.label}
          tone={routingHealth.tone}
          hint={
            routingStatus?.routedAppCount
              ? `${routingStatus.routedAppCount} route${routingStatus.routedAppCount === 1 ? "" : "s"}`
              : undefined
          }
        />
        <StatCard
          label="Docker"
          value={dockerInfo?.status === "connected" ? "Connected" : "Unavailable"}
          tone={dockerInfo?.status === "connected" ? "positive" : "negative"}
          hint={dockerInfo?.dockerVersion}
        />
        <StatCard
          label="Host Resources"
          value={dockerInfo ? `${dockerInfo.cpuCount} cores` : "—"}
          hint={dockerInfo ? formatMemory(dockerInfo.memoryTotalBytes) : undefined}
        />
      </section>

      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Applications</p>
            <h2>Apps</h2>
          </div>

          <div className="section-heading-actions">
            {serviceApps.length > 0 && (
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

            <button className="primary-button compact" type="button" onClick={onCreateApp}>
              Create App
            </button>
          </div>
        </div>

        {serviceApps.length === 0 ? (
          <div className="empty-state app-empty-state">
            <h3>No apps yet</h3>
            <p>Deploy your first application from a Docker image.</p>
            <button className="primary-button" type="button" onClick={onCreateApp}>
              Deploy First App
            </button>
          </div>
        ) : view === "table" ? (
          <AppTable
            managedApps={serviceApps}
            storedAppsByName={storedAppsByName}
            missingApps={[]}
            actionLoading={actionLoading}
            onAction={onAction}
            onOpenLogs={onOpenLogs}
            onDeleteApp={onDeleteApp}
            onDeleteMissingApp={() => {}}
            onViewApp={onViewApp}
          />
        ) : (
          <div className="container-grid">
            {serviceApps.map((container) => {
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
          </div>
        )}
      </section>
    </div>
  );
}
