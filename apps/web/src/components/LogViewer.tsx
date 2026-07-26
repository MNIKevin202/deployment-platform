import { useCallback, useEffect, useState } from "react";
import type { ApiError, LogsResponse } from "../types/api";

interface LogViewerProps {
  containerId: string;
  title: string;
  onClose?: () => void;
  variant?: "modal" | "inline";
}

export default function LogViewer({
  containerId,
  title,
  onClose,
  variant = "modal"
}: LogViewerProps) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadLogs = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(`/api/containers/${containerId}/logs`);

      if (!response.ok) {
        const result = (await response
          .json()
          .catch(() => ({}))) as ApiError;
        throw new Error(result.message || "Unable to load container logs");
      }

      const result = (await response.json()) as LogsResponse;
      setLogs(result.logs || "");
    } catch (loadError) {
      setLogs("");
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load container logs"
      );
    } finally {
      setLoading(false);
    }
  }, [containerId]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const body = (
    <section
      className={variant === "modal" ? "logs-modal" : "logs-modal logs-inline"}
      onClick={
        variant === "modal" ? (event) => event.stopPropagation() : undefined
      }
    >
      <header>
        <div>
          <p className="eyebrow">Container Logs</p>
          <h2>{title}</h2>
        </div>

        <div className="header-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void loadLogs()}
            disabled={loading}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>

          {variant === "modal" && onClose && (
            <button className="close-button" type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </header>

      {loading && logs === "" && !error ? (
        <p className="logs-state">Loading logs...</p>
      ) : error ? (
        <p className="logs-state logs-error">{error}</p>
      ) : logs === "" ? (
        <p className="logs-state">No logs available yet.</p>
      ) : (
        <pre>{logs}</pre>
      )}
    </section>
  );

  if (variant === "inline") {
    return body;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {body}
    </div>
  );
}
