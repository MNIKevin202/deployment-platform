import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, ContainerMetrics, MetricsResponse } from "../types/api";
import MetricsSparkline from "./MetricsSparkline";

interface MetricsPanelProps {
  appId: number;
  containerRunning: boolean;
}

const POLL_INTERVAL_MS = 5000;
/** 60 points at a 5s poll interval = a 5-minute rolling window. */
const MAX_HISTORY_POINTS = 60;

interface MetricsPoint {
  ts: number;
  cpuPercent: number;
  memoryUsageBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "—";
  }

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

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export default function MetricsPanel({ appId, containerRunning }: MetricsPanelProps) {
  const [metrics, setMetrics] = useState<ContainerMetrics | null>(null);
  const [history, setHistory] = useState<MetricsPoint[]>([]);
  const [containerRunningState, setContainerRunningState] = useState(containerRunning);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const inFlight = useRef(false);

  // A fresh app (or a fresh mount of the same app) starts its rolling window
  // over — carrying another app's history across a click would be misleading.
  useEffect(() => {
    setHistory([]);
  }, [appId]);

  const loadMetrics = useCallback(async () => {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;

    try {
      setError("");

      const response = await fetch(`/api/apps/${appId}/metrics`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load metrics"));
      }

      const result = (await response.json()) as MetricsResponse;
      setContainerRunningState(result.containerRunning);
      setMetrics(result.metrics);
      setLastRefreshed(new Date());

      if (result.metrics) {
        const point: MetricsPoint = {
          ts: Date.now(),
          cpuPercent: result.metrics.cpuPercent ?? 0,
          memoryUsageBytes: result.metrics.memoryUsageBytes ?? 0,
          networkRxBytes: result.metrics.networkRxBytes ?? 0,
          networkTxBytes: result.metrics.networkTxBytes ?? 0
        };

        setHistory((previous) => {
          const next = [...previous, point];
          return next.length > MAX_HISTORY_POINTS
            ? next.slice(next.length - MAX_HISTORY_POINTS)
            : next;
        });
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load metrics");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [appId]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  useEffect(() => {
    if (!containerRunningState) {
      return;
    }

    const tick = () => {
      if (document.hidden) {
        return;
      }
      void loadMetrics();
    };

    const interval = window.setInterval(tick, POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void loadMetrics();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [containerRunningState, loadMetrics]);

  return (
    <div className="app-detail-tab-panel">
      <div className="env-scope-heading">
        <h3>Live Resource Metrics</h3>
        <div className="container-actions">
          <span className="text-faint">
            {lastRefreshed ? `Refreshed ${lastRefreshed.toLocaleTimeString()}` : ""}
          </span>
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void loadMetrics()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && !metrics ? (
        <div className="empty-state">Loading metrics...</div>
      ) : !containerRunningState ? (
        <div className="empty-state">
          The container is not running, so no live metrics are available.
        </div>
      ) : !metrics ? (
        <div className="empty-state">Metrics are currently unavailable for this app.</div>
      ) : (
        <>
          <div className="metrics-chart-grid">
            <div className="metric-chart-card">
              <span className="stat-card-label">CPU</span>
              <span className="stat-card-value">{formatPercent(metrics.cpuPercent)}</span>
              <MetricsSparkline
                data={history}
                dataKey="cpuPercent"
                color="var(--color-accent)"
                formatValue={(value) => `${value.toFixed(1)}%`}
              />
            </div>

            <div className="metric-chart-card">
              <span className="stat-card-label">Memory</span>
              <span className="stat-card-value">{formatBytes(metrics.memoryUsageBytes)}</span>
              <span className="stat-card-hint">
                {metrics.memoryLimitBytes
                  ? `of ${formatBytes(metrics.memoryLimitBytes)} (${formatPercent(metrics.memoryPercent)})`
                  : "No limit set"}
              </span>
              <MetricsSparkline
                data={history}
                dataKey="memoryUsageBytes"
                color="var(--color-success)"
                formatValue={(value) => formatBytes(value)}
              />
            </div>

            <div className="metric-chart-card">
              <span className="stat-card-label">Network In</span>
              <span className="stat-card-value">{formatBytes(metrics.networkRxBytes)}</span>
              <MetricsSparkline
                data={history}
                dataKey="networkRxBytes"
                color="var(--color-warning)"
                formatValue={(value) => formatBytes(value)}
              />
            </div>

            <div className="metric-chart-card">
              <span className="stat-card-label">Network Out</span>
              <span className="stat-card-value">{formatBytes(metrics.networkTxBytes)}</span>
              <MetricsSparkline
                data={history}
                dataKey="networkTxBytes"
                color="var(--color-danger)"
                formatValue={(value) => formatBytes(value)}
              />
            </div>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-card-label">Disk I/O</span>
              <span className="stat-card-value">{formatBytes(metrics.blockReadBytes)} read</span>
              <span className="stat-card-hint">{formatBytes(metrics.blockWriteBytes)} written</span>
            </div>

            <div className="stat-card">
              <span className="stat-card-label">Processes</span>
              <span className="stat-card-value">{metrics.pids ?? "—"}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
