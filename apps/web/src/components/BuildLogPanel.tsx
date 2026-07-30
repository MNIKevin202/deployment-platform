import { useCallback, useEffect, useState } from "react";
import type { ApiError, BuildLog, BuildLogResponse } from "../types/api";

interface BuildLogPanelProps {
  appId: number;
  appName: string;
}

const STATUS_TONES: Record<string, "positive" | "negative" | "neutral"> = {
  success: "positive",
  failed: "negative",
  reused: "neutral"
};

const STATUS_LABELS: Record<string, string> = {
  success: "Build succeeded",
  failed: "Build failed",
  reused: "Image reused"
};

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string | null): string {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function BuildLogPanel({ appId, appName }: BuildLogPanelProps) {
  const [buildLog, setBuildLog] = useState<BuildLog | null>(null);
  // Distinguishes "no source linked" (null response) from "source, no build yet".
  const [hasSource, setHasSource] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  const loadBuildLog = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(`/api/apps/${appId}/build-log`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load build logs"));
      }

      const result = (await response.json()) as BuildLogResponse;
      setHasSource(result.buildLog !== null);
      setBuildLog(result.buildLog);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load build logs");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void loadBuildLog();
  }, [loadBuildLog]);

  const logText = buildLog?.log ?? "";

  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Unable to copy to the clipboard. Select and copy the text manually.");
    }
  };

  const downloadLog = () => {
    const blob = new Blob([logText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${appName}-build.log`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const status = buildLog?.status ?? null;
  const hasLog = Boolean(buildLog && buildLog.log);

  return (
    <div className="app-detail-tab-panel">
      <div className="logs-toolbar">
        <div className="logs-toolbar-group">
          <h3>Build log</h3>
          {status && (
            <span className={`status-badge compact ${STATUS_TONES[status] ?? "neutral"}`}>
              {STATUS_LABELS[status] ?? status}
            </span>
          )}
          {buildLog?.at && <span className="text-faint">{formatDate(buildLog.at)}</span>}
        </div>

        <div className="logs-toolbar-group">
          <label className="checkbox-field">
            <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
            <span>Wrap lines</span>
          </label>
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void copyLog()}
            disabled={!hasLog}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <button className="secondary-button compact" type="button" onClick={downloadLog} disabled={!hasLog}>
            Download
          </button>
          <button
            className="primary-button compact"
            type="button"
            onClick={() => void loadBuildLog()}
            disabled={loading}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {buildLog?.truncated && (
        <div className="warning-banner">
          The build output was large and has been truncated to the most recent portion.
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="logs-modal logs-inline">
        {loading && !buildLog && !error ? (
          <p className="logs-state">Loading build log...</p>
        ) : !hasSource ? (
          <p className="logs-state">
            This app runs a prebuilt image, so it has no build logs. Its live output is on the Console
            tab.
          </p>
        ) : !hasLog ? (
          <p className="logs-state">
            No build has run yet. Deploy this app from GitHub to produce a build log.
          </p>
        ) : (
          <pre className={wrap ? undefined : "logs-nowrap"}>{logText}</pre>
        )}
      </div>
    </div>
  );
}
