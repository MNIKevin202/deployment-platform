import type { ContainerAction, ContainerSummary, StoredApp } from "../types/api";
import { useDeployProgress } from "../lib/deployProgress";
import { InlineDeployProgress } from "./DeployProgressIndicator";

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
}

function domainCell(storedApp: StoredApp | undefined, canOpen: boolean) {
  if (storedApp?.internalOnly) {
    return <span className="routing-badge internal-only">Internal only</span>;
  }
  if (storedApp?.domain) {
    return canOpen ? (
      <a href={`https://${storedApp.domain}`} target="_blank" rel="noreferrer" className="table-link">
        {storedApp.domain}
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
  onViewApp
}: AppTableProps) {
  const deployProgress = useDeployProgress();

  return (
    <div className="table-wrap">
      <table className="env-table apps-table">
        <thead>
          <tr>
            <th>App</th>
            <th>Status</th>
            <th>Image</th>
            <th>Domain</th>
            <th>Update</th>
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
                <td>
                  {storedApp ? (
                    <button className="table-name-button" type="button" onClick={() => onViewApp(storedApp)}>
                      {name}
                    </button>
                  ) : (
                    name
                  )}
                </td>
                <td>
                  {deploying ? (
                    <InlineDeployProgress progress={deploying} />
                  ) : (
                    <span className={`status-pill ${isRunning ? "running" : "stopped"}`}>
                      {container.state}
                    </span>
                  )}
                </td>
                <td>
                  <code className="inline-code">{container.image}</code>
                </td>
                <td>{domainCell(storedApp, canOpen)}</td>
                <td>
                  {storedApp?.imageUpdateAvailable ? (
                    <span className="status-badge compact warning">Update Available</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td>
                  <div className="apps-table-actions">
                    {canOpen && (
                      <a
                        className="secondary-button compact"
                        href={`https://${storedApp?.domain}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                      </a>
                    )}
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
                        className="secondary-button compact"
                        type="button"
                        onClick={() => onAction(container, "start")}
                        disabled={actionLoading === `${container.id}:start`}
                      >
                        Start
                      </button>
                    )}
                    <button
                      className="secondary-button compact"
                      type="button"
                      onClick={() => onAction(container, "restart")}
                      disabled={!isRunning || actionLoading === `${container.id}:restart`}
                    >
                      Restart
                    </button>
                    <button className="secondary-button compact" type="button" onClick={() => onOpenLogs(container)}>
                      Logs
                    </button>
                    <button
                      className="danger-button compact"
                      type="button"
                      onClick={() => onDeleteApp(container)}
                      disabled={actionLoading === `${container.id}:delete`}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}

          {missingApps.map((storedApp) => (
            <tr key={`missing-${storedApp.id}`} className="apps-table-missing-row">
              <td>
                <button className="table-name-button" type="button" onClick={() => onViewApp(storedApp)}>
                  {storedApp.containerName ?? storedApp.name}
                </button>
              </td>
              <td>
                <span className="status-pill stopped">missing</span>
              </td>
              <td>
                <code className="inline-code">{storedApp.image}</code>
              </td>
              <td>{domainCell(storedApp, false)}</td>
              <td>
                <span className="text-faint">—</span>
              </td>
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
