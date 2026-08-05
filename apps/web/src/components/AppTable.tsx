import { useState } from "react";
import type { ContainerAction, ContainerSummary, StoredApp } from "../types/api";
import { useDeployProgress } from "../lib/deployProgress";
import { InlineDeployProgress } from "./DeployProgressIndicator";
import { formatRelativeTimeFromIso } from "../lib/formatTime";
import { inferAppCategory } from "../lib/appKind";

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

/** A small "copy to clipboard" affordance for the image/container-id line — non-fatal if the browser denies clipboard access. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="copy-button"
      aria-label={`Copy ${label}`}
      title={copied ? "Copied!" : `Copy ${label}`}
      onClick={async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access denied/unavailable — silently do nothing.
        }
      }}
    >
      {copied ? "✓" : "⧉"}
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
  onToggleFavorite
}: AppTableProps) {
  const deployProgress = useDeployProgress();

  return (
    <div className="table-wrap">
      <table className="env-table apps-table">
        <thead>
          <tr>
            <th aria-label="Favorite" />
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
            const name = container.names[0]?.replace(/^\//, "") ?? container.shortId;
            const deploying = storedApp ? deployProgress.get(storedApp.id) : undefined;

            return (
              <tr key={container.id}>
                <td>{favoriteButton(storedApp?.id ?? -1, Boolean(storedApp && favoriteAppIds?.has(storedApp.id)), storedApp ? onToggleFavorite : undefined)}</td>
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
                        disabled={actionLoading === `${container.id}:stop`}
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        className="primary-button compact"
                        type="button"
                        onClick={() => onAction(container, "start")}
                        disabled={actionLoading === `${container.id}:start`}
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
                      disabled={!isRunning || actionLoading === `${container.id}:restart`}
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
                      disabled={actionLoading === `${container.id}:delete`}
                    >
                      🗑
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}

          {missingApps.map((storedApp) => (
            <tr key={`missing-${storedApp.id}`} className="apps-table-missing-row">
              <td>{favoriteButton(storedApp.id, Boolean(favoriteAppIds?.has(storedApp.id)), onToggleFavorite)}</td>
              <td>
                <button className="table-name-button apps-table-app-button" type="button" onClick={() => onViewApp(storedApp)}>
                  {appCategoryCell(storedApp.containerName ?? storedApp.name, storedApp.image, storedApp.internalOnly, Boolean(storedApp.domain))}
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
                    disabled={actionLoading === `app-${storedApp.id}:delete`}
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
