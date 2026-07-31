import { useCallback, useEffect, useRef, useState } from "react";
import type { DockerInfo, MetricsSummaryResponse } from "../types/api";
import MetricsSparkline from "./MetricsSparkline";

interface ClusterMetricsChartProps {
  dockerInfo: DockerInfo | null;
}

const POLL_INTERVAL_MS = 10000;
/** 30 points at a 10s poll interval = a 5-minute rolling window. */
const MAX_HISTORY_POINTS = 30;

interface ClusterMetricsPoint {
  ts: number;
  cpuPercent: number;
  memoryUsageBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * A live, rolling-window view of how busy this host is right now — total CPU
 * and memory used across every running managed container. Polls a single
 * server-side aggregate endpoint (not one request per app) so the cost stays
 * flat regardless of how many apps are deployed.
 */
export default function ClusterMetricsChart({ dockerInfo }: ClusterMetricsChartProps) {
  const [history, setHistory] = useState<ClusterMetricsPoint[]>([]);
  const [latest, setLatest] = useState<ClusterMetricsPoint | null>(null);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);

  const loadSummary = useCallback(async () => {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;

    try {
      const response = await fetch("/api/apps/metrics/summary");

      if (!response.ok) {
        setError(true);
        return;
      }

      const result = (await response.json()) as MetricsSummaryResponse;

      if (!result.success) {
        setError(true);
        return;
      }

      setError(false);

      const point: ClusterMetricsPoint = {
        ts: Date.now(),
        cpuPercent: result.cpuPercentTotal,
        memoryUsageBytes: result.memoryUsageBytesTotal
      };

      setLatest(point);
      setHistory((previous) => {
        const next = [...previous, point];
        return next.length > MAX_HISTORY_POINTS
          ? next.slice(next.length - MAX_HISTORY_POINTS)
          : next;
      });
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void loadSummary();

    const tick = () => {
      if (document.hidden) {
        return;
      }
      void loadSummary();
    };

    const interval = window.setInterval(tick, POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void loadSummary();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadSummary]);

  if (error && !latest) {
    return null;
  }

  const cpuCount = dockerInfo?.cpuCount ?? null;
  const cpuCapacityPercent = cpuCount ? cpuCount * 100 : null;
  const memoryTotalBytes = dockerInfo?.memoryTotalBytes ?? null;

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Live</p>
          <h2>Host Resource Usage</h2>
        </div>
      </div>

      <div className="metrics-chart-grid">
        <div className="metric-chart-card">
          <span className="stat-card-label">Cluster CPU</span>
          <span className="stat-card-value">
            {latest ? `${latest.cpuPercent.toFixed(1)}%` : "—"}
          </span>
          <span className="stat-card-hint">
            {cpuCapacityPercent
              ? `of ${cpuCapacityPercent}% capacity (${cpuCount} core${cpuCount === 1 ? "" : "s"})`
              : "Across all running apps"}
          </span>
          <MetricsSparkline
            data={history}
            dataKey="cpuPercent"
            color="var(--color-accent)"
            domain={cpuCapacityPercent ? [0, cpuCapacityPercent] : [0, "auto"]}
            formatValue={(value) => `${value.toFixed(1)}%`}
          />
        </div>

        <div className="metric-chart-card">
          <span className="stat-card-label">Cluster Memory</span>
          <span className="stat-card-value">
            {latest ? formatBytes(latest.memoryUsageBytes) : "—"}
          </span>
          <span className="stat-card-hint">
            {memoryTotalBytes ? `of ${formatBytes(memoryTotalBytes)} total` : "Across all running apps"}
          </span>
          <MetricsSparkline
            data={history}
            dataKey="memoryUsageBytes"
            color="var(--color-success)"
            domain={memoryTotalBytes ? [0, memoryTotalBytes] : [0, "auto"]}
            formatValue={(value) => formatBytes(value)}
          />
        </div>
      </div>
    </section>
  );
}
