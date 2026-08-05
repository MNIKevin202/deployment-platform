import { lazy, Suspense, useEffect, useState } from "react";
import StatCard from "../components/StatCard";
import AppCard from "../components/AppCard";
import AppTable from "../components/AppTable";
import AttentionPanel from "../components/AttentionPanel";
import { useSpeedtest } from "../hooks/useSpeedtest";

// Pulls in recharts (a large dependency) only once Overview actually
// mounts, instead of shipping it in the app's initial bundle.
const ClusterMetricsChart = lazy(() => import("../components/ClusterMetricsChart"));
import { useAppsView } from "../hooks/useAppsView";
import { isDatabaseImage } from "../lib/appKind";
import {
  computePlatformHealth,
  type AutoBackupStatus,
  type DiskUsageStatus,
  type PlatformHealthStatus
} from "../lib/platformHealth";
import type {
  ContainerAction,
  ContainerSummary,
  DockerInfo,
  RoutingStatus,
  StoredApp
} from "../types/api";

/**
 * How often the platform-health inputs not already covered by App.tsx's 5s
 * dashboard poll (disk usage, backup status) are refreshed. Both endpoints
 * are already cheap/cached server-side (see docker-usage-service.ts), but
 * there's no reason to poll them faster than DiskSettings.tsx does for the
 * same underlying data.
 */
const HEALTH_POLL_INTERVAL_MS = 60_000;

const PLATFORM_HEALTH_LABEL: Record<PlatformHealthStatus, string> = {
  healthy: "Healthy",
  warning: "Needs Attention",
  critical: "Critical"
};

const PLATFORM_HEALTH_TONE: Record<PlatformHealthStatus, "positive" | "warning" | "negative"> = {
  healthy: "positive",
  warning: "warning",
  critical: "negative"
};

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
  onBrowseTemplates?: () => void;
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
  onCreateApp,
  onBrowseTemplates
}: OverviewPageProps) {
  const serviceApps = managedApps.filter((c) => !isDatabaseImage(c.image));
  const databaseApps = managedApps.filter((c) => isDatabaseImage(c.image));
  const [view, setView] = useAppsView();
  const runningCount = managedApps.filter((c) => c.state === "running").length;
  const stoppedCount = managedApps.length - runningCount;
  const routingHealth = routingHealthLabel(routingStatus);

  // Disk usage and backup status aren't part of App.tsx's 5s dashboard poll —
  // self-fetched here, slower, since Platform Health is the only consumer.
  const [diskUsage, setDiskUsage] = useState<DiskUsageStatus | null>(null);
  const [autoBackup, setAutoBackup] = useState<AutoBackupStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadHealthInputs() {
      try {
        const response = await fetch("/api/settings/retention");
        const result = await response.json().catch(() => null);
        if (!cancelled && response.ok && result?.success && result.usage) {
          setDiskUsage({ usedBytes: result.usage.usedBytes, totalBytes: result.usage.totalBytes });
        }
      } catch {
        // Non-fatal — the disk-usage attention check is simply skipped.
      }

      try {
        const response = await fetch("/api/settings/auto-backup");
        const result = await response.json().catch(() => null);
        if (!cancelled && response.ok && result?.success && result.config) {
          setAutoBackup({
            enabled: result.config.enabled,
            intervalHours: result.config.intervalHours,
            lastRunAt: result.lastRunAt
          });
        }
      } catch {
        // Non-fatal — the backup-overdue attention check is simply skipped.
      }
    }

    void loadHealthInputs();
    const interval = window.setInterval(() => void loadHealthInputs(), HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const speedtest = useSpeedtest();

  const health = computePlatformHealth({
    managedApps,
    storedAppsByName,
    dockerInfo,
    routingStatus,
    diskUsage,
    autoBackup
  });

  return (
    <div className="page">
      <section className="stats-grid platform-health-grid">
        <StatCard
          label="Platform Health"
          value={PLATFORM_HEALTH_LABEL[health.status]}
          tone={PLATFORM_HEALTH_TONE[health.status]}
          hint={
            health.items.length > 0
              ? `${health.items.length} item${health.items.length === 1 ? "" : "s"} need attention`
              : "All systems normal"
          }
        />
      </section>

      <AttentionPanel items={health.items} onViewApp={onViewApp} />

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
        {/* Only rendered once a Speedtest Tracker is connected — an
            unconfigured integration shows nothing rather than an empty card. */}
        {speedtest.data?.configured && speedtest.data.reading && (
          <StatCard
            label="Internet Speed"
            value={speedtest.data.reading.downloadHuman ?? "—"}
            tone={speedtest.data.reading.healthy === false ? "warning" : "positive"}
            hint={
              [
                speedtest.data.reading.uploadHuman ? `${speedtest.data.reading.uploadHuman} up` : null,
                speedtest.data.reading.pingMs !== null
                  ? `${speedtest.data.reading.pingMs.toFixed(0)} ms`
                  : null
              ]
                .filter(Boolean)
                .join(" · ") || undefined
            }
          />
        )}
      </section>

      <Suspense fallback={null}>
        <ClusterMetricsChart dockerInfo={dockerInfo} />
      </Suspense>

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

            {onBrowseTemplates && (
              <button className="secondary-button compact" type="button" onClick={onBrowseTemplates}>
                Templates
              </button>
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
