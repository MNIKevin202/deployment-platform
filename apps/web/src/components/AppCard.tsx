import type { ContainerAction, ContainerPort, ContainerSummary, StoredApp } from "../types/api";

interface AppCardProps {
  container: ContainerSummary;
  storedApp?: StoredApp;
  actionLoading: string | null;
  onAction: (container: ContainerSummary, action: ContainerAction) => void;
  onOpenLogs: (container: ContainerSummary) => void;
  onDeleteApp?: (container: ContainerSummary) => void;
  onViewApp?: (storedApp: StoredApp) => void;
}

function formatPorts(ports: ContainerPort[]): string {
  if (ports.length === 0) {
    return "No exposed ports";
  }

  return ports
    .map((port) =>
      port.PublicPort
        ? `${port.PublicPort}:${port.PrivatePort}/${port.Type}`
        : `${port.PrivatePort}/${port.Type}`
    )
    .join(", ");
}

export default function AppCard({
  container,
  storedApp,
  actionLoading,
  onAction,
  onOpenLogs,
  onDeleteApp,
  onViewApp
}: AppCardProps) {
  const isRunning = container.state === "running";
  const containerName = container.names[0] ?? container.shortId;

  const canOpenApp = Boolean(storedApp?.domain && storedApp.routingReady);
  const canStart = !container.isSystemContainer && !isRunning;

  // At most one action is highlighted as "primary" per card — the single
  // most useful next step for its current state — so hierarchy comes from
  // color/weight, not from making buttons different sizes.
  const highlightStart = canStart && !canOpenApp;

  return (
    <article className="container-card">
      <div className="container-card-header">
        <div>
          <div className="title-row">
            <h3>{containerName}</h3>

            {container.isSystemContainer && (
              <span className="type-badge system">Protected</span>
            )}
          </div>

          <p>{container.image}</p>
        </div>

        <div className="card-status">
          <span className={`status-pill ${isRunning ? "running" : "stopped"}`}>
            {container.state}
          </span>
          <span className="card-status-detail">{container.status}</span>
        </div>
      </div>

      <dl className="container-details">
        <div>
          <dt>ID</dt>
          <dd>{container.shortId}</dd>
        </div>

        <div>
          <dt>Ports</dt>
          <dd>{formatPorts(container.ports)}</dd>
        </div>

        {storedApp?.domain && (
          <div>
            <dt>Domain</dt>
            <dd>
              {storedApp.domain}
              {!storedApp.routingReady && (
                <span className="routing-badge not-ready">
                  Routing not yet active
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>

      <div className="container-actions card-actions">
        {canOpenApp && (
          <a
            className="primary-button open-app-button"
            href={`https://${storedApp?.domain}`}
            target="_blank"
            rel="noreferrer"
          >
            Open App
          </a>
        )}

        {container.isManagedApp && storedApp && onViewApp && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => onViewApp(storedApp)}
          >
            View App
          </button>
        )}

        {canStart && (
          <button
            className={highlightStart ? "primary-button" : undefined}
            onClick={() => onAction(container, "start")}
            disabled={actionLoading === `${container.id}:start`}
          >
            {actionLoading === `${container.id}:start` ? "Starting..." : "Start"}
          </button>
        )}

        {!container.isSystemContainer && isRunning && (
          <button
            onClick={() => onAction(container, "stop")}
            disabled={actionLoading === `${container.id}:stop`}
          >
            {actionLoading === `${container.id}:stop` ? "Stopping..." : "Stop"}
          </button>
        )}

        {!container.isSystemContainer && (
          <button
            onClick={() => onAction(container, "restart")}
            disabled={
              !isRunning || actionLoading === `${container.id}:restart`
            }
          >
            {actionLoading === `${container.id}:restart`
              ? "Restarting..."
              : "Restart"}
          </button>
        )}

        <button onClick={() => onOpenLogs(container)}>Logs</button>

        {container.isManagedApp && onDeleteApp && (
          <button
            className="danger-button"
            onClick={() => onDeleteApp(container)}
            disabled={actionLoading === `${container.id}:delete`}
          >
            {actionLoading === `${container.id}:delete` ? "Deleting..." : "Delete"}
          </button>
        )}
      </div>

      {container.isSystemContainer && (
        <p className="protected-note">
          Platform services are protected from stop, restart, and delete
          actions.
        </p>
      )}
    </article>
  );
}
