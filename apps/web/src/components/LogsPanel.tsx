import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, AppLogsResponse } from "../types/api";

interface LogsPanelProps {
  appId: number;
  appName: string;
  containerRunning: boolean;
}

const POLL_INTERVAL_MS = 5000;
const TAIL_OPTIONS = [100, 200, 500, 1000];

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

export default function LogsPanel({ appId, appName, containerRunning }: LogsPanelProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [containerRunningState, setContainerRunningState] = useState(containerRunning);
  const [containerExists, setContainerExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [retrievedAt, setRetrievedAt] = useState<string | null>(null);

  const [tail, setTail] = useState(200);
  const [timestamps, setTimestamps] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);

  const loadLogs = useCallback(async () => {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;

    try {
      setError("");

      const params = new URLSearchParams({
        tail: String(tail),
        timestamps: String(timestamps)
      });

      const response = await fetch(`/api/apps/${appId}/logs?${params.toString()}`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load logs"));
      }

      const result = (await response.json()) as AppLogsResponse;

      setContainerRunningState(result.containerRunning);
      setContainerExists(result.containerId !== null);
      setLines(result.lines);
      setTruncated(result.truncated);
      setRetrievedAt(result.retrievedAt);

      if (result.error) {
        setError(result.error);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load logs");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [appId, tail, timestamps]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!autoRefresh || !containerRunningState) {
      return;
    }

    const tick = () => {
      if (document.hidden) {
        return;
      }
      void loadLogs();
    };

    const interval = window.setInterval(tick, POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [autoRefresh, containerRunningState, loadLogs]);

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Unable to copy to the clipboard. Select and copy the text manually.");
    }
  };

  const downloadLogs = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${appName}-logs.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-detail-tab-panel">
      <div className="logs-toolbar">
        <div className="logs-toolbar-group">
          <label className="logs-toolbar-field">
            <span>Tail</span>
            <select
              className="wizard-select"
              value={tail}
              onChange={(event) => setTail(Number(event.target.value))}
            >
              {TAIL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={timestamps}
              onChange={(event) => setTimestamps(event.target.checked)}
            />
            <span>Timestamps</span>
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
            />
            <span>Wrap lines</span>
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span>Auto refresh</span>
          </label>
        </div>

        <div className="logs-toolbar-group">
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void copyLogs()}
            disabled={lines.length === 0}
          >
            {copied ? "Copied!" : "Copy Logs"}
          </button>
          <button
            className="secondary-button compact"
            type="button"
            onClick={downloadLogs}
            disabled={lines.length === 0}
          >
            Download
          </button>
          <button
            className="primary-button compact"
            type="button"
            onClick={() => void loadLogs()}
            disabled={loading}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {truncated && (
        <div className="warning-banner">
          The log output was too large and has been truncated to the most recent portion.
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="logs-modal logs-inline">
        {loading && lines.length === 0 && !error ? (
          <p className="logs-state">Loading logs...</p>
        ) : !containerExists ? (
          <p className="logs-state">
            The container for this app does not exist, so there are no logs to show.
          </p>
        ) : !containerRunningState && lines.length === 0 ? (
          <p className="logs-state">
            The container is stopped. Showing the most recent logs before it stopped, if any.
          </p>
        ) : lines.length === 0 ? (
          <p className="logs-state">No log output yet.</p>
        ) : (
          <pre className={wrap ? undefined : "logs-nowrap"}>{lines.join("\n")}</pre>
        )}
      </div>

      {retrievedAt && (
        <p className="text-faint">Retrieved {new Date(retrievedAt).toLocaleTimeString()}</p>
      )}
    </div>
  );
}
