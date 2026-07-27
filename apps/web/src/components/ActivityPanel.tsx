import { Fragment, useCallback, useEffect, useState } from "react";
import type { ApiError, DeploymentEvent, DeploymentEventsResponse } from "../types/api";

interface ActivityPanelProps {
  appId: number;
}

const PAGE_LIMIT = 30;

const EVENT_TYPE_LABELS: Record<string, string> = {
  "app-created": "App created",
  "container-started": "Container started",
  "container-stopped": "Container stopped",
  "container-restarted": "Container restarted",
  "redeploy-started": "Redeploy started",
  "redeploy-succeeded": "Redeploy succeeded",
  "redeploy-failed": "Redeploy failed",
  "health-became-healthy": "Became healthy",
  "health-became-unhealthy": "Became unhealthy",
  "health-check-error": "Health check error",
  "routing-warning": "Routing warning",
  "cleanup-warning": "Cleanup warning",
  "source-linked": "Source linked",
  "source-updated": "Source updated",
  "source-removed": "Source removed",
  "source-validation-succeeded": "Source validated",
  "source-validation-failed": "Source validation failed",
  "github-deploy-started": "GitHub deploy started",
  "github-deploy-progress": "GitHub deploy progress",
  "github-deploy-succeeded": "GitHub deploy succeeded",
  "github-deploy-failed": "GitHub deploy failed",
  "github-deploy-rolled-back": "GitHub deploy rolled back"
};

// Keys are already flat, primitive-only, and pre-sanitized server-side
// (see deployment-event-service.ts's sanitizeMetadata) before they ever
// reach this component — this only decides how to *label* and *format*
// each one for a readable card instead of a raw JSON dump.
const METADATA_KEY_LABELS: Record<string, string> = {
  stage: "Stage",
  exitCode: "Exit code",
  signal: "Signal",
  timedOut: "Timed out",
  aborted: "Aborted",
  processStarted: "Process started",
  spawnErrorCode: "Spawn error code",
  stderrSummary: "Error detail",
  stdoutSummary: "Output detail",
  rolledBack: "Rolled back",
  commitShortSha: "Commit",
  imageTag: "Image tag",
  configuredPort: "Configured port",
  internalStatusCode: "Internal result",
  internalReachable: "Internal reachable",
  publicStatusCode: "Public result",
  publicReachable: "Public reachable"
};

/** Values formatted specially per key — e.g. an HTTP status code reads better as "HTTP 200" than a bare number. */
const HTTP_STATUS_KEYS = new Set(["internalStatusCode", "publicStatusCode"]);

function formatMetadataKey(key: string): string {
  if (METADATA_KEY_LABELS[key]) {
    return METADATA_KEY_LABELS[key];
  }
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

function formatMetadataValue(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (HTTP_STATUS_KEYS.has(key) && typeof value === "number") {
    return `HTTP ${value}`;
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return String(value);
}

const SEVERITY_TONES: Record<string, "positive" | "negative" | "neutral" | "warning"> = {
  info: "neutral",
  warning: "warning",
  error: "negative"
};

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function ActivityPanel({ appId }: ActivityPanelProps) {
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(`/api/apps/${appId}/events?limit=${PAGE_LIMIT}`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load activity"));
      }

      const result = (await response.json()) as DeploymentEventsResponse;
      setEvents(result.events);
      setHasMore(result.hasMore);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load activity");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const loadMore = async () => {
    if (events.length === 0) {
      return;
    }

    try {
      setLoadingMore(true);
      setError("");

      const lastId = events[events.length - 1].id;
      const response = await fetch(
        `/api/apps/${appId}/events?limit=${PAGE_LIMIT}&before=${lastId}`
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load more activity"));
      }

      const result = (await response.json()) as DeploymentEventsResponse;
      setEvents((current) => [...current, ...result.events]);
      setHasMore(result.hasMore);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load more activity");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="app-detail-tab-panel">
      <div className="env-scope-heading">
        <h3>Activity</h3>
        <button
          className="secondary-button compact"
          type="button"
          onClick={() => void loadEvents()}
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && events.length === 0 ? (
        <div className="empty-state">Loading activity...</div>
      ) : events.length === 0 ? (
        <div className="empty-state">No activity recorded for this app yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="env-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Severity</th>
                <th>Message</th>
                <th aria-label="Details" />
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <Fragment key={event.id}>
                  <tr>
                    <td className="text-faint">{formatDate(event.createdAt)}</td>
                    <td>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</td>
                    <td>
                      <span
                        className={`status-badge compact ${SEVERITY_TONES[event.severity] ?? "neutral"}`}
                      >
                        {event.severity}
                      </span>
                    </td>
                    <td>{event.message}</td>
                    <td className="env-actions-cell">
                      {event.metadata && (
                        <button
                          className="secondary-button compact"
                          type="button"
                          onClick={() =>
                            setExpandedId((current) => (current === event.id ? null : event.id))
                          }
                        >
                          {expandedId === event.id ? "Hide" : "Details"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedId === event.id && event.metadata && (
                    <tr>
                      <td colSpan={5}>
                        <dl className="wizard-review-grid">
                          {Object.entries(event.metadata).map(([key, value]) => (
                            <div key={key}>
                              <dt>{formatMetadataKey(key)}</dt>
                              <dd>{formatMetadataValue(key, value)}</dd>
                            </div>
                          ))}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="form-actions form-actions-start">
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}
