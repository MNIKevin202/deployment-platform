import AppCard from "../components/AppCard";
import type { ContainerAction, ContainerSummary, DockerInfo } from "../types/api";

interface SystemPageProps {
  systemContainers: ContainerSummary[];
  dockerInfo: DockerInfo | null;
  actionLoading: string | null;
  onAction: (container: ContainerSummary, action: ContainerAction) => void;
  onOpenLogs: (container: ContainerSummary) => void;
}

function formatMemory(bytes: number | undefined): string {
  if (!bytes) {
    return "Unknown";
  }

  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function SystemPage({
  systemContainers,
  dockerInfo,
  actionLoading,
  onAction,
  onOpenLogs
}: SystemPageProps) {
  return (
    <div className="page">
      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Host</p>
            <h2>Docker Daemon</h2>
          </div>
        </div>

        <div className="server-card">
          <div>
            <span>Docker</span>
            <strong>{dockerInfo?.dockerVersion ?? "Unknown"}</strong>
          </div>

          <div>
            <span>Operating system</span>
            <strong>{dockerInfo?.operatingSystem ?? "Unknown"}</strong>
          </div>

          <div>
            <span>Architecture</span>
            <strong>{dockerInfo?.architecture ?? "Unknown"}</strong>
          </div>

          <div>
            <span>CPU cores</span>
            <strong>{dockerInfo?.cpuCount ?? "Unknown"}</strong>
          </div>

          <div>
            <span>Total memory</span>
            <strong>{formatMemory(dockerInfo?.memoryTotalBytes)}</strong>
          </div>

          <div>
            <span>Images</span>
            <strong>{dockerInfo?.images ?? "Unknown"}</strong>
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Core Infrastructure</p>
            <h2>Platform Services</h2>
          </div>

          <span className="container-count">
            {systemContainers.length} protected
          </span>
        </div>

        {systemContainers.length === 0 ? (
          <div className="empty-state">
            No system containers were found.
          </div>
        ) : (
          <div className="container-grid">
            {systemContainers.map((container) => (
              <AppCard
                key={container.id}
                container={container}
                actionLoading={actionLoading}
                onAction={onAction}
                onOpenLogs={onOpenLogs}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
