import { useCallback, useEffect, useState } from "react";
import type { ApiError, AppDetail as AppDetailData, ContainerAction } from "../types/api";
import StatusBadge from "./StatusBadge";
import ConfirmationDialog from "./ConfirmationDialog";
import LogViewer from "./LogViewer";

interface AppDetailProps {
  appId: number;
  onBack: () => void;
  onDeleted: () => void;
  onAppChanged: () => void;
}

async function readApiError(
  response: Response,
  fallbackMessage: string
): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

export default function AppDetail({
  appId,
  onBack,
  onDeleted,
  onAppChanged
}: AppDetailProps) {
  const [detail, setDetail] = useState<AppDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionLoading, setActionLoading] = useState<
    ContainerAction | "delete" | null
  >(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const loadDetail = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");
      setNotFound(false);

      const response = await fetch(`/api/apps/${appId}`);

      if (response.status === 404) {
        setNotFound(true);
        return;
      }

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to load app details")
        );
      }

      const result = (await response.json()) as AppDetailData;
      setDetail(result);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to load app details"
      );
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const runAction = async (action: ContainerAction) => {
    if (!detail?.containerId || actionLoading) {
      return;
    }

    try {
      setActionError("");
      setNotice("");
      setActionLoading(action);

      const response = await fetch(
        `/api/containers/${detail.containerId}/${action}`,
        { method: "POST" }
      );

      if (!response.ok) {
        throw new Error(
          await readApiError(response, `Unable to ${action} app`)
        );
      }

      setNotice(`App ${action} completed.`);
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : `Unable to ${action} app`
      );
    } finally {
      setActionLoading(null);
    }
  };

  const confirmDelete = async () => {
    if (!detail?.containerId || actionLoading) {
      return;
    }

    try {
      setActionError("");
      setActionLoading("delete");

      const response = await fetch(`/api/apps/${detail.containerId}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to delete app"));
      }

      setShowDeleteConfirm(false);
      onAppChanged();
      onDeleted();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to delete app"
      );
      setActionLoading(null);
    }
  };

  if (loading && !detail) {
    return (
      <section className="app-detail">
        <button className="secondary-button" type="button" onClick={onBack}>
          Back
        </button>
        <p className="empty-state">Loading app details...</p>
      </section>
    );
  }

  if (notFound) {
    return (
      <section className="app-detail">
        <button className="secondary-button" type="button" onClick={onBack}>
          Back
        </button>
        <div className="empty-state">
          <h3>App not found</h3>
          <p>This app may have already been deleted.</p>
        </div>
      </section>
    );
  }

  if (loadError || !detail) {
    return (
      <section className="app-detail">
        <button className="secondary-button" type="button" onClick={onBack}>
          Back
        </button>
        <div className="error-banner">
          {loadError || "Unable to load app details"}
        </div>
      </section>
    );
  }

  const isRunning = detail.dockerState === "running";
  const canOpenApp = Boolean(detail.domain) && detail.routingReady;

  return (
    <section className="app-detail">
      <div className="app-detail-header">
        <button className="secondary-button" type="button" onClick={onBack}>
          Back
        </button>

        <div className="app-detail-title-row">
          <h1>{detail.name}</h1>
          <StatusBadge
            label={detail.containerExists ? detail.dockerState ?? "unknown" : "missing"}
            tone={
              !detail.containerExists
                ? "negative"
                : isRunning
                  ? "positive"
                  : "neutral"
            }
          />
          <StatusBadge label={`Desired: ${detail.desiredStatus}`} tone="neutral" />
          <StatusBadge
            label={canOpenApp ? "Routing ready" : "Routing not ready"}
            tone={canOpenApp ? "positive" : "warning"}
          />
        </div>
      </div>

      {actionError && <div className="error-banner">{actionError}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      {!detail.containerExists && (
        <div className="error-banner">
          The Docker container for this app is missing. Actions are disabled
          until it is redeployed or the record is repaired.
        </div>
      )}

      <dl className="app-detail-grid">
        <div>
          <dt>Public domain</dt>
          <dd>{detail.domain ?? "Not assigned"}</dd>
        </div>

        <div>
          <dt>Docker image</dt>
          <dd>{detail.image}</dd>
        </div>

        <div>
          <dt>Internal port</dt>
          <dd>{detail.containerPort}</dd>
        </div>

        <div>
          <dt>Container name</dt>
          <dd>{detail.containerName ?? "Unknown"}</dd>
        </div>

        <div>
          <dt>Container ID</dt>
          <dd title={detail.containerId ?? undefined}>
            {detail.shortContainerId ?? "Unknown"}
          </dd>
        </div>

        <div>
          <dt>Docker status</dt>
          <dd>{detail.dockerStatusText ?? "Unavailable"}</dd>
        </div>

        <div>
          <dt>Restart policy</dt>
          <dd>{detail.restartPolicy}</dd>
        </div>

        <div>
          <dt>Created</dt>
          <dd>{formatDate(detail.createdAt)}</dd>
        </div>

        <div>
          <dt>Updated</dt>
          <dd>{formatDate(detail.updatedAt)}</dd>
        </div>

        <div>
          <dt>Last deployed</dt>
          <dd>{formatDate(detail.lastDeployedAt)}</dd>
        </div>
      </dl>

      <div className="container-actions app-detail-actions">
        {canOpenApp && (
          <a
            className="secondary-button open-app-button"
            href={`https://${detail.domain}`}
            target="_blank"
            rel="noreferrer"
          >
            Open App
          </a>
        )}

        {detail.containerExists && !isRunning && (
          <button
            type="button"
            onClick={() => void runAction("start")}
            disabled={actionLoading !== null}
          >
            {actionLoading === "start" ? "Starting..." : "Start"}
          </button>
        )}

        {detail.containerExists && isRunning && (
          <button
            type="button"
            onClick={() => void runAction("stop")}
            disabled={actionLoading !== null}
          >
            {actionLoading === "stop" ? "Stopping..." : "Stop"}
          </button>
        )}

        {detail.containerExists && (
          <button
            type="button"
            onClick={() => void runAction("restart")}
            disabled={!isRunning || actionLoading !== null}
          >
            {actionLoading === "restart" ? "Restarting..." : "Restart"}
          </button>
        )}

        {detail.containerExists && (
          <button type="button" onClick={() => setShowLogs(true)}>
            View Logs
          </button>
        )}

        {detail.containerExists && (
          <button
            className="danger-button"
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={actionLoading !== null}
          >
            Delete
          </button>
        )}
      </div>

      {showLogs && detail.containerId && (
        <LogViewer
          containerId={detail.containerId}
          title={detail.name}
          onClose={() => setShowLogs(false)}
        />
      )}

      <ConfirmationDialog
        open={showDeleteConfirm}
        title={`Delete ${detail.name}?`}
        message={
          <p>
            This permanently removes the <strong>{detail.name}</strong>{" "}
            container and its anonymous volumes. This cannot be undone.
          </p>
        }
        confirmLabel="Delete app"
        danger
        confirming={actionLoading === "delete"}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </section>
  );
}
