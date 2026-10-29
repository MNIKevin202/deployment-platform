import type { ContainerAction, ContainerPort, ContainerSummary, StoredApp } from "../types/api";
import { useAppDeployProgress } from "../lib/deployProgress";
import { InlineDeployProgress } from "./DeployProgressIndicator";
import { formatRelativeTimeFromIso } from "../lib/formatTime";
import { displayAppName } from "../lib/appName";
import ActionMenu, { type ActionMenuItem } from "./ActionMenu";
import Icon from "./Icon";

interface AppTileProps {
  container: ContainerSummary;
  storedApp?: StoredApp;
  actionLoading: string | null;
  onAction: (container: ContainerSummary, action: ContainerAction) => void;
  onOpenLogs: (container: ContainerSummary) => void;
  onDeleteApp?: (container: ContainerSummary) => void;
  onViewApp?: (storedApp: StoredApp) => void;
  isFavorite?: boolean;
  onToggleFavorite?: (appId: number) => void;
  selected?: boolean;
  onToggleSelected?: () => void;
}

/** Health only ever comes from the app's own configured check. Neutral
 *  "unknown" is intentionally not surfaced — it is noise, not a signal. */
function summarizeHealth(
  isRunning: boolean,
  health: StoredApp["health"] | undefined
): { label: string; tone: "positive" | "negative" } | null {
  if (!isRunning) {
    return null;
  }
  const state = health?.state;
  if (state === "healthy") {
    return { label: "Healthy", tone: "positive" };
  }
  if (state === "unhealthy" || state === "container-not-running") {
    return { label: "Unhealthy", tone: "negative" };
  }
  if (state && state !== "disabled" && state !== "unknown") {
    return { label: "Health error", tone: "negative" };
  }
  return null;
}

function portsSummary(ports: ContainerPort[]): string | null {
  if (ports.length === 0) {
    return null;
  }
  return ports
    .map((port) =>
      port.PublicPort ? `${port.PublicPort}:${port.PrivatePort}/${port.Type}` : `${port.PrivatePort}/${port.Type}`
    )
    .join(" · ");
}

export default function AppTile({
  container,
  storedApp,
  actionLoading,
  onAction,
  onOpenLogs,
  onDeleteApp,
  onViewApp,
  isFavorite = false,
  onToggleFavorite,
  selected = false,
  onToggleSelected
}: AppTileProps) {
  const isRunning = container.state === "running";
  const containerName = displayAppName(storedApp?.name, container.names[0], container.shortId);
  const deploying = useAppDeployProgress(storedApp?.id);

  const canOpenApp = Boolean(storedApp?.domain && storedApp.routingReady);
  const canStart = !container.isSystemContainer && !isRunning;
  const canViewApp = Boolean(container.isManagedApp && storedApp && onViewApp);
  const bulkBusy = actionLoading?.startsWith("bulk:") ?? false;
  const health = summarizeHealth(isRunning, storedApp?.health ?? undefined);

  const state: "running" | "stopped" | "failed" =
    storedApp?.latestEventSeverity === "error" ? "failed" : isRunning ? "running" : "stopped";
  const monogram = containerName.trim().charAt(0).toUpperCase() || "•";
  const ports = portsSummary(container.ports);
  const deployedAgo = formatRelativeTimeFromIso(storedApp?.lastDeployedAt);

  const busy = (action: string) => actionLoading === `${container.id}:${action}`;

  // Secondary actions live in an overflow menu so the tile isn't a wall of
  // buttons. The single most useful next step is the primary button.
  const menuItems: ActionMenuItem[] = [];
  if (canViewApp && (canOpenApp || canStart)) {
    menuItems.push({ label: "View app", icon: <Icon name="external" size={15} />, onClick: () => onViewApp?.(storedApp!) });
  }
  if (canStart && canOpenApp) {
    menuItems.push({
      label: busy("start") ? "Starting…" : "Start",
      icon: <Icon name="play" size={15} />,
      disabled: bulkBusy || busy("start"),
      onClick: () => onAction(container, "start")
    });
  }
  if (!container.isSystemContainer && isRunning) {
    menuItems.push({
      label: busy("stop") ? "Stopping…" : "Stop",
      icon: <Icon name="stop" size={15} />,
      disabled: bulkBusy || busy("stop"),
      onClick: () => onAction(container, "stop")
    });
  }
  if (!container.isSystemContainer) {
    menuItems.push({
      label: busy("restart") ? "Restarting…" : "Restart",
      icon: <Icon name="refresh" size={15} />,
      disabled: bulkBusy || !isRunning || busy("restart"),
      onClick: () => onAction(container, "restart")
    });
  }
  menuItems.push({ label: "View logs", icon: <Icon name="logs" size={15} />, onClick: () => onOpenLogs(container) });
  if (container.isManagedApp && onDeleteApp) {
    menuItems.push({
      label: busy("delete") ? "Deleting…" : "Delete",
      icon: <Icon name="trash" size={15} />,
      danger: true,
      disabled: bulkBusy || busy("delete"),
      onClick: () => onDeleteApp(container)
    });
  }

  return (
    <article className={`app-tile app-tile--${state}${selected ? " selected" : ""}`}>
      <span className="app-tile-rail" aria-hidden="true" />

      <header className="app-tile-head">
        {onToggleSelected && (
          <input
            type="checkbox"
            className="app-tile-select"
            aria-label={`Select ${containerName}`}
            checked={selected}
            onChange={onToggleSelected}
            disabled={bulkBusy}
          />
        )}
        <span className={`app-tile-avatar app-tile-avatar--${state}`} aria-hidden="true">
          {monogram}
        </span>
        <div className="app-tile-headings">
          <h3 className="app-tile-name" title={containerName}>
            {containerName}
          </h3>
          <div className="app-tile-status-line">
            {deploying ? (
              <InlineDeployProgress progress={deploying} />
            ) : (
              <span className={`app-tile-state app-tile-state--${state}`}>
                <span className="app-tile-dot" aria-hidden="true" />
                {isRunning ? "Running" : "Stopped"}
              </span>
            )}
            {health && (
              <span className={`app-tile-chip ${health.tone}`}>{health.label}</span>
            )}
            {container.isSystemContainer && <span className="app-tile-chip">Protected</span>}
          </div>
        </div>

        <div className="app-tile-head-actions">
          {storedApp && onToggleFavorite && (
            <button
              type="button"
              className={`app-tile-fav${isFavorite ? " active" : ""}`}
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={isFavorite}
              onClick={() => onToggleFavorite(storedApp.id)}
            >
              {isFavorite ? "★" : "☆"}
            </button>
          )}
          <ActionMenu items={menuItems} label={`More actions for ${containerName}`} disabled={bulkBusy} />
        </div>
      </header>

      <div className="app-tile-address">
        {storedApp?.internalOnly ? (
          <span className="app-tile-internal">
            <Icon name="shield" size={14} /> Internal only
          </span>
        ) : storedApp?.domain ? (
          canOpenApp ? (
            <a className="app-tile-domain" href={`https://${storedApp.domain}`} target="_blank" rel="noreferrer">
              <Icon name="globe" size={14} />
              <span>{storedApp.domain}</span>
              <Icon name="external" size={13} />
            </a>
          ) : (
            <span className="app-tile-domain muted">
              <Icon name="globe" size={14} />
              <span>{storedApp.domain}</span>
              <span className="app-tile-chip warning">Routing not yet active</span>
            </span>
          )
        ) : (
          <span className="app-tile-domain muted">
            <Icon name="box" size={14} />
            <span>No public domain</span>
          </span>
        )}
      </div>

      <div className="app-tile-meta">
        {storedApp?.currentVersion != null && (
          <span className="app-tile-meta-item" title={storedApp.currentVersionCommitSha ?? undefined}>
            v{storedApp.currentVersion}
          </span>
        )}
        {ports && <span className="app-tile-meta-item">{ports}</span>}
        <span className="app-tile-meta-item">{container.status}</span>
        {deployedAgo && <span className="app-tile-meta-item">Deployed {deployedAgo}</span>}
      </div>

      {(storedApp?.imageUpdateAvailable ||
        storedApp?.latestEventSeverity === "warning" ||
        storedApp?.latestEventSeverity === "error") && (
        <div className="app-tile-flags">
          {storedApp?.imageUpdateAvailable && (
            <span className="app-tile-chip warning" title="A newer image is available in the registry — redeploy to update">
              Update Available
            </span>
          )}
          {(storedApp?.latestEventSeverity === "warning" || storedApp?.latestEventSeverity === "error") && (
            <span
              className={`app-tile-chip ${storedApp.latestEventSeverity === "error" ? "negative" : "warning"}`}
              title="A recent deployment or health event needs attention — see the Activity tab"
            >
              Recent Warning
            </span>
          )}
        </div>
      )}

      <footer className="app-tile-foot">
        {canOpenApp ? (
          <a className="primary-button app-tile-primary" href={`https://${storedApp?.domain}`} target="_blank" rel="noreferrer">
            Open App <Icon name="external" size={15} />
          </a>
        ) : canStart ? (
          <button
            className="primary-button app-tile-primary"
            type="button"
            disabled={bulkBusy || busy("start")}
            onClick={() => onAction(container, "start")}
          >
            {busy("start") ? "Starting…" : "Start"}
          </button>
        ) : canViewApp ? (
          <button className="secondary-button app-tile-primary" type="button" onClick={() => onViewApp?.(storedApp!)}>
            Manage
          </button>
        ) : (
          <button className="secondary-button app-tile-primary" type="button" onClick={() => onOpenLogs(container)}>
            View logs
          </button>
        )}
        {canViewApp && (canOpenApp || canStart) && (
          <button className="secondary-button" type="button" onClick={() => onViewApp?.(storedApp!)}>
            Manage
          </button>
        )}
      </footer>

      {container.isSystemContainer && (
        <p className="app-tile-protected">Platform service — protected from stop, restart, and delete.</p>
      )}
    </article>
  );
}
