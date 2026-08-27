import type { ContainerAction, ContainerSummary, StoredApp } from "../types/api";
import { useDeployProgress } from "../lib/deployProgress";
import { InlineDeployProgress } from "./DeployProgressIndicator";
import { formatRelativeTimeFromIso } from "../lib/formatTime";
import { inferAppCategory } from "../lib/appKind";
import { displayAppName } from "../lib/appName";
import CopyButton from "./CopyButton";
import { appSelectionKey, containerSelectionKey } from "../lib/appSelection";

interface AppTableProps {
  managedApps: ContainerSummary[];
  storedAppsByName: Map<string, StoredApp>;
  missingApps: StoredApp[];
  actionLoading: string | null;
  onAction: (container: ContainerSummary, action: ContainerAction) => void;
  onOpenLogs: (container: ContainerSummary) => void;
  onDeleteApp: (container: ContainerSummary) => void;
  onDeleteMissingApp: (storedApp: StoredApp) => void;
  onViewApp: (storedApp: StoredApp) => void;
  favoriteAppIds?: ReadonlySet<number>;
  onToggleFavorite?: (appId: number) => void;
  selectedAppKeys?: ReadonlySet<string>;
  onToggleSelected?: (key: string) => void;
  onToggleAllVisible?: () => void;
}

function favoriteButton(
  appId: number,
  isFavorite: boolean,
  onToggleFavorite: ((appId: number) => void) | undefined
) {
  if (!onToggleFavorite) {
    return null;
  }
  return (
    <button
      type="button"
      className="favorite-toggle compact"
      aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={isFavorite}
      onClick={(event) => {
        event.stopPropagation();
        onToggleFavorite(appId);
      }}
    >
      {isFavorite ? "★" : "☆"}
    </button>
  );
}

function appCategoryCell(
  name: string,
  image: string,
  internalOnly: boolean,
  hasDomain: boolean,
  updateAvailable = false
) {
  const category = inferAppCategory(image);
  return (
    <div className="apps-table-app-cell">
      <span className="apps-table-app-icon" aria-hidden="true">
        {category.icon}
      </span>
      <div className="apps-table-app-meta">
        {/* title carries the full name, since the cell truncates it. */}
        <span className="apps-table-app-name" title={name}>
          {name}
        </span>
        <span className="apps-table-app-subtitle">
          {category.label}
          {internalOnly ? (
            <span className="status-badge compact neutral">Internal</span>
          ) : (
            hasDomain && <span className="status-badge compact positive">Public</span>
          )}
          {updateAvailable && (
            <span
              className="status-badge compact warning"
              title="A newer image is available in the registry — redeploy to update"
            >
              Update Available
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function domainCell(storedApp: StoredApp | undefined, canOpen: boolean) {
  if (storedApp?.internalOnly) {
    return <span className="routing-badge internal-only">Internal only</span>;
  }
  if (storedApp?.domain) {
    return canOpen ? (
      <a href={`https://${storedApp.domain}`} target="_blank" rel="noreferrer" className="table-link">
        {storedApp.domain} <span aria-hidden="true">↗</span>
      </a>
    ) : (
      <span className="text-faint">{storedApp.domain}</span>
    );
  }
  return <span className="text-faint">—</span>;
}

export default function AppTable({
  managedApps,
  storedAppsByName,
  missingApps,
  actionLoading,
  onAction,
  onOpenLogs,
  onDeleteApp,
  onDeleteMissingApp,
  onViewApp,
  favoriteAppIds,
  onToggleFavorite,
  selectedAppKeys = new Set(),
  onToggleSelected,
  onToggleAllVisible
}: AppTableProps) {
  const deployProgress = useDeployProgress();
  const bulkBusy = actionLoading?.startsWith("bulk:") ?? false;
  const visibleKeys = [
    ...managedApps.map((container) => {
      const appName = container.labels["com.deployment-platform.app-name"];
      return containerSelectionKey(container, appName ? storedAppsByName.get(appName) : undefined);
    }),
    ...missingApps.map(appSelectionKey)
  ];
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((key) => selectedAppKeys.has(key));

  return (
    <div className="table-wrap">
      <table className="env-table apps-table">
        <thead>
          <tr>
            <th aria-label="Select and favorite">
              {onToggleSelected && onToggleAllVisible && (
                <input
                  type="checkbox"
                  aria-label="Select all visible apps"
                  checked={allVisibleSelected}
                  onChange={onToggleAllVisible}
                  disabled={bulkBusy}
                />
              )}
            </th>
            <th>App</th>
            <th>Status</th>
            <th>Image</th>
            <th>Version</th>
            <th>Last Deployed</th>
            <th>Domain</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {managedApps.map((container) => {
            const appName = container.labels["com.deployment-platform.app-name"];
            const storedApp = appName ? storedAppsByName.get(appName) : undefined;
            const isRunning = container.state === "running";
            const canOpen = Boolean(storedApp?.domain && storedApp.routingReady);
            const name = displayAppName(storedApp?.name, container.names[0], container.shortId);
            const deploying = storedApp ? deployProgress.get(storedApp.id) : undefined;
            const selectionKey = containerSelectionKey(container, storedApp);

            return (
              <tr
                key={container.id}
                className={selectedAppKeys.has(selectionKey) ? "apps-table-selected-row" : undefined}
                aria-selected={selectedAppKeys.has(selectionKey)}
              >
                <td>
                  <div className="apps-table-selection-cell">
                    {onToggleSelected && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${name}`}
                        checked={selectedAppKeys.has(selectionKey)}
                        onChange={() => onToggleSelected(selectionKey)}
                        disabled={bulkBusy}
                      />
                    )}
                    {favoriteButton(storedApp?.id ?? -1, Boolean(storedApp && favoriteAppIds?.has(storedApp.id)), storedApp ? onToggleFavorite : undefined)}
                  </div>
                </td>
                <td>
                  {storedApp ? (
                    <button className="table-name-button apps-table-app-button" type="button" onClick={() => onViewApp(storedApp)}>
                      {appCategoryCell(
                        name,
                        container.image,
                        storedApp.internalOnly,
                        Boolean(storedApp.domain),
                        Boolean(storedApp.imageUpdateAvailable)
                      )}
                    </button>
                  ) : (
                    appCategoryCell(name, container.image, false, false)
                  )}
                </td>
                <td>
                  {deploying ? (
                    <InlineDeployProgress progress={deploying} />
                  ) : (
                    <div className="apps-table-status-cell">
                      <span className={`status-pill ${isRunning ? "running" : "stopped"}`}>
                        {container.state}
                      </span>
                      <span className="apps-table-subtext">{container.status}</span>
                    </div>
                  )}
                </td>
                <td>
                  <div className="apps-table-image-cell">
                    <code className="inline-code" title={container.image}>
                      {container.image}
                    </code>
                    <span className="apps-table-subtext apps-table-id-row">
                      {container.shortId}
                      <CopyButton value={container.image} label="image name" />
                    </span>
                  </div>
                </td>
                <td>
                  {storedApp?.currentVersion != null ? (
                    <span title={storedApp.currentVersionCommitSha ?? undefined}>v{storedApp.currentVersion}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className="text-faint">
                  <div className="apps-table-last-deployed">
                    <span>{formatRelativeTimeFromIso(storedApp?.lastDeployedAt) ?? "—"}</span>
                    {storedApp?.lastDeployedAt && (
                      <span className="apps-table-subtext">{new Date(storedApp.lastDeployedAt).toLocaleString()}</span>
                    )}
                  </div>
                </td>
                <td>{domainCell(storedApp, canOpen)}</td>
                <td>
                  <div className="apps-table-actions">
                    {/* No separate "Open" button here — the Domain cell beside
                        it is already a link that opens the app, and the extra
                        button crowded the row enough to clip itself. */}
                    {isRunning ? (
                      <button
                        className="secondary-button compact"
                        type="button"
                        onClick={() => onAction(container, "stop")}
                        disabled={bulkBusy || actionLoading === `${container.id}:stop`}
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        className="primary-button compact"
                        type="button"
                        onClick={() => onAction(container, "start")}
                        disabled={bulkBusy || actionLoading === `${container.id}:start`}
                      >
                        Start
                      </button>
                    )}
                    <button
                      className="icon-button compact"
                      type="button"
                      aria-label="Restart"
                      title="Restart"
                      onClick={() => onAction(container, "restart")}
                      disabled={bulkBusy || !isRunning || actionLoading === `${container.id}:restart`}
                    >
                      ↻
                    </button>
                    <button
                      className="icon-button compact"
                      type="button"
                      aria-label="Logs"
                      title="Logs"
                      onClick={() => onOpenLogs(container)}
                    >
                      ▤
                    </button>
                    <button
                      className="icon-button compact danger"
                      type="button"
                      aria-label="Delete"
                      title="Delete"
                      onClick={() => onDeleteApp(container)}
                      disabled={bulkBusy || actionLoading === `${container.id}:delete`}
                    >
                      🗑
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}

          {missingApps.map((storedApp) => (
            <tr
              key={`missing-${storedApp.id}`}
              className={`apps-table-missing-row${
                selectedAppKeys.has(appSelectionKey(storedApp))
                  ? " apps-table-selected-row"
                  : ""
              }`}
              aria-selected={selectedAppKeys.has(appSelectionKey(storedApp))}
            >
              <td>
                <div className="apps-table-selection-cell">
                  {onToggleSelected && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${displayAppName(storedApp.name, storedApp.containerName)}`}
                      checked={selectedAppKeys.has(appSelectionKey(storedApp))}
                      onChange={() => onToggleSelected(appSelectionKey(storedApp))}
                      disabled={bulkBusy}
                    />
                  )}
                  {favoriteButton(storedApp.id, Boolean(favoriteAppIds?.has(storedApp.id)), onToggleFavorite)}
                </div>
              </td>
              <td>
                <button className="table-name-button apps-table-app-button" type="button" onClick={() => onViewApp(storedApp)}>
                  {appCategoryCell(displayAppName(storedApp.name, storedApp.containerName), storedApp.image, storedApp.internalOnly, Boolean(storedApp.domain))}
                </button>
              </td>
              <td>
                <span className="status-pill stopped">missing</span>
              </td>
              <td>
                <div className="apps-table-image-cell">
                  <code className="inline-code" title={storedApp.image}>
                    {storedApp.image}
                  </code>
                </div>
              </td>
              <td>
                {storedApp.currentVersion != null ? (
                  <span title={storedApp.currentVersionCommitSha ?? undefined}>v{storedApp.currentVersion}</span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className="text-faint">{formatRelativeTimeFromIso(storedApp.lastDeployedAt) ?? "—"}</td>
              <td>{domainCell(storedApp, false)}</td>
              <td>
                <div className="apps-table-actions">
                  <button className="secondary-button compact" type="button" onClick={() => onViewApp(storedApp)}>
                    View
                  </button>
                  <button
                    className="danger-button compact"
                    type="button"
                    onClick={() => onDeleteMissingApp(storedApp)}
                    disabled={bulkBusy || actionLoading === `app-${storedApp.id}:delete`}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
