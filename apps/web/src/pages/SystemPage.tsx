import AppCard from "../components/AppCard";
import { useSpeedtest } from "../hooks/useSpeedtest";
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

/** Connectivity belongs with the host's other vitals, in fuller detail than the Overview card. */
function InternetSection() {
  const { data } = useSpeedtest();

  if (!data?.configured) {
    return null;
  }

  const r = data.reading;

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Host</p>
          <h2>Internet Connection</h2>
        </div>
      </div>

      {!r ? (
        <p className="text-faint">{data.error ?? "No speedtest result recorded yet."}</p>
      ) : (
        <div className="server-card">
          <div>
            <span>Download</span>
            <strong>{r.downloadHuman ?? "Unknown"}</strong>
          </div>
          <div>
            <span>Upload</span>
            <strong>{r.uploadHuman ?? "Unknown"}</strong>
          </div>
          <div>
            <span>Ping</span>
            <strong>{r.pingMs !== null ? `${r.pingMs.toFixed(1)} ms` : "Unknown"}</strong>
          </div>
          <div>
            <span>Jitter</span>
            <strong>{r.jitterMs !== null ? `${r.jitterMs.toFixed(1)} ms` : "Unknown"}</strong>
          </div>
          <div>
            <span>Packet loss</span>
            <strong>{r.packetLoss !== null ? `${r.packetLoss}%` : "Unknown"}</strong>
          </div>
          <div>
            <span>ISP</span>
            <strong>{r.isp ?? "Unknown"}</strong>
          </div>
          <div>
            <span>Test server</span>
            <strong>{r.serverName ?? "Unknown"}</strong>
          </div>
          <div>
            <span>Measured</span>
            <strong>{r.measuredAt ? new Date(r.measuredAt).toLocaleString() : "Unknown"}</strong>
          </div>
        </div>
      )}
    </section>
  );
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
      <InternetSection />

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
