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
  "cleanup-warning": "Cleanup warning"
};

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
                        <pre className="event-metadata">
                          {JSON.stringify(event.metadata, null, 2)}
                        </pre>
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
