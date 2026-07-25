import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

interface DockerInfo {
  status: string;
  containers: number;
  containersRunning: number;
  containersStopped: number;
  images: number;
  dockerVersion: string;
  operatingSystem: string;
  architecture: string;
}

interface ContainerPort {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

interface ContainerSummary {
  id: string;
  shortId: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  created: number;
  ports: ContainerPort[];
  labels: Record<string, string>;
  isSystemContainer: boolean;
  isManagedApp: boolean;
}

interface LogsResponse {
  containerId: string;
  logs: string;
}

interface ApiError {
  message?: string;
}

interface CreateAppResponse {
  success: boolean;
  message: string;
  app?: {
    id: string;
    shortId: string;
    name: string;
    containerName: string;
    image: string;
    containerPort: number;
    state: string;
  };
}

type ContainerAction = "start" | "stop" | "restart";

function App() {
  const [dockerInfo, setDockerInfo] = useState<DockerInfo | null>(null);
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [selectedContainer, setSelectedContainer] =
    useState<ContainerSummary | null>(null);
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [showCreateApp, setShowCreateApp] = useState(false);
  const [appName, setAppName] = useState("");
  const [appImage, setAppImage] = useState("");
  const [containerPort, setContainerPort] = useState("80");
  const [creatingApp, setCreatingApp] = useState(false);

  const systemContainers = useMemo(
    () => containers.filter((container) => container.isSystemContainer),
    [containers]
  );

  const managedApps = useMemo(
    () => containers.filter((container) => container.isManagedApp),
    [containers]
  );

  const otherContainers = useMemo(
    () =>
      containers.filter(
        (container) =>
          !container.isSystemContainer && !container.isManagedApp
      ),
    [containers]
  );

  const loadDashboard = useCallback(async () => {
    try {
      const [infoResponse, containersResponse] = await Promise.all([
        fetch("/api/docker/info"),
        fetch("/api/containers")
      ]);

      if (!infoResponse.ok || !containersResponse.ok) {
        throw new Error("Unable to load Docker information");
      }

      const info = (await infoResponse.json()) as DockerInfo;
      const containerList =
        (await containersResponse.json()) as ContainerSummary[];

      setDockerInfo(info);
      setContainers(containerList);

      setSelectedContainer((currentSelection) => {
        if (!currentSelection) {
          return null;
        }

        return (
          containerList.find(
            (container) => container.id === currentSelection.id
          ) ?? null
        );
      });

      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load dashboard"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();

    const interval = window.setInterval(() => {
      void loadDashboard();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [loadDashboard]);

  const getApiError = async (
    response: Response,
    fallbackMessage: string
  ): Promise<string> => {
    try {
      const result = (await response.json()) as ApiError;
      return result.message || fallbackMessage;
    } catch {
      return fallbackMessage;
    }
  };

  const runAction = async (
    container: ContainerSummary,
    action: ContainerAction
  ) => {
    try {
      setError("");
      setNotice("");
      setActionLoading(`${container.id}:${action}`);

      const response = await fetch(
        `/api/containers/${container.id}/${action}`,
        {
          method: "POST"
        }
      );

      if (!response.ok) {
        throw new Error(
          await getApiError(
            response,
            `Unable to ${action} container`
          )
        );
      }

      setNotice(
        `${container.names[0] ?? container.shortId} ${action} completed.`
      );

      await loadDashboard();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Container action failed"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const openLogs = async (container: ContainerSummary) => {
    try {
      setError("");
      setSelectedContainer(container);
      setLogs("Loading logs...");

      const response = await fetch(
        `/api/containers/${container.id}/logs`
      );

      if (!response.ok) {
        throw new Error(
          await getApiError(response, "Unable to load container logs")
        );
      }

      const result = (await response.json()) as LogsResponse;
      setLogs(result.logs || "No logs available.");
    } catch (logsError) {
      setLogs("");
      setError(
        logsError instanceof Error
          ? logsError.message
          : "Unable to load logs"
      );
    }
  };

  const createApp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsedPort = Number(containerPort);

    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError("Container port must be between 1 and 65535.");
      return;
    }

    try {
      setCreatingApp(true);
      setError("");
      setNotice("");

      const response = await fetch("/api/apps", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: appName.trim(),
          image: appImage.trim(),
          containerPort: parsedPort
        })
      });

      if (!response.ok) {
        throw new Error(
          await getApiError(response, "Unable to deploy app")
        );
      }

      const result = (await response.json()) as CreateAppResponse;

      setNotice(result.message || "App deployed successfully.");
      setShowCreateApp(false);
      setAppName("");
      setAppImage("");
      setContainerPort("80");

      await loadDashboard();
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Unable to deploy app"
      );
    } finally {
      setCreatingApp(false);
    }
  };

  const deleteApp = async (container: ContainerSummary) => {
    const containerName =
      container.names[0] ?? container.shortId;

    const confirmed = window.confirm(
      `Delete ${containerName}?\n\nThe container and its anonymous volumes will be removed.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setError("");
      setNotice("");
      setActionLoading(`${container.id}:delete`);

      const response = await fetch(`/api/apps/${container.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(
          await getApiError(response, "Unable to delete app")
        );
      }

      setNotice(`${containerName} was deleted.`);
      await loadDashboard();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete app"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const formatPorts = (ports: ContainerPort[]) => {
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
  };

  const renderContainerCard = (container: ContainerSummary) => {
    const isRunning = container.state === "running";
    const containerName =
      container.names[0] ?? container.shortId;

    return (
      <article className="container-card" key={container.id}>
        <div className="container-card-header">
          <div>
            <div className="title-row">
              <h3>{containerName}</h3>

              {container.isSystemContainer && (
                <span className="type-badge system">Protected</span>
              )}

              {container.isManagedApp && (
                <span className="type-badge managed">Managed App</span>
              )}
            </div>

            <p>{container.image}</p>
          </div>

          <span
            className={`status-pill ${
              isRunning ? "running" : "stopped"
            }`}
          >
            {container.state}
          </span>
        </div>

        <dl className="container-details">
          <div>
            <dt>ID</dt>
            <dd>{container.shortId}</dd>
          </div>

          <div>
            <dt>Status</dt>
            <dd>{container.status}</dd>
          </div>

          <div>
            <dt>Ports</dt>
            <dd>{formatPorts(container.ports)}</dd>
          </div>
        </dl>

        <div className="container-actions">
          {!container.isSystemContainer && !isRunning && (
            <button
              onClick={() => void runAction(container, "start")}
              disabled={
                actionLoading === `${container.id}:start`
              }
            >
              {actionLoading === `${container.id}:start`
                ? "Starting..."
                : "Start"}
            </button>
          )}

          {!container.isSystemContainer && isRunning && (
            <button
              onClick={() => void runAction(container, "stop")}
              disabled={
                actionLoading === `${container.id}:stop`
              }
            >
              {actionLoading === `${container.id}:stop`
                ? "Stopping..."
                : "Stop"}
            </button>
          )}

          {!container.isSystemContainer && (
            <button
              onClick={() => void runAction(container, "restart")}
              disabled={
                !isRunning ||
                actionLoading === `${container.id}:restart`
              }
            >
              {actionLoading === `${container.id}:restart`
                ? "Restarting..."
                : "Restart"}
            </button>
          )}

          <button onClick={() => void openLogs(container)}>
            Logs
          </button>

          {container.isManagedApp && (
            <button
              className="danger-button"
              onClick={() => void deleteApp(container)}
              disabled={
                actionLoading === `${container.id}:delete`
              }
            >
              {actionLoading === `${container.id}:delete`
                ? "Deleting..."
                : "Delete"}
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
  };

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">Deployment Platform</p>
          <h1>Docker Dashboard</h1>
          <p className="subtitle">
            Deploy and manage applications running on your server.
          </p>
        </div>

        <div className="header-actions">
          <button
            className="secondary-button"
            onClick={() => void loadDashboard()}
          >
            Refresh
          </button>

          <button
            className="primary-button"
            onClick={() => {
              setError("");
              setNotice("");
              setShowCreateApp(true);
            }}
          >
            Create App
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      {loading ? (
        <section className="empty-state">
          Loading Docker information...
        </section>
      ) : (
        <>
          <section className="stats-grid">
            <article className="stat-card">
              <span>Status</span>
              <strong>{dockerInfo?.status ?? "Unknown"}</strong>
            </article>

            <article className="stat-card">
              <span>Running</span>
              <strong>{dockerInfo?.containersRunning ?? 0}</strong>
            </article>

            <article className="stat-card">
              <span>Stopped</span>
              <strong>{dockerInfo?.containersStopped ?? 0}</strong>
            </article>

            <article className="stat-card">
              <span>Images</span>
              <strong>{dockerInfo?.images ?? 0}</strong>
            </article>
          </section>

          <section className="server-card">
            <div>
              <span>Docker</span>
              <strong>{dockerInfo?.dockerVersion ?? "Unknown"}</strong>
            </div>

            <div>
              <span>Operating system</span>
              <strong>{dockerInfo?.operatingSystem ?? "Unknown"}</strong>
            </div>

            <div>
              <span>Architecture</span>
              <strong>{dockerInfo?.architecture ?? "Unknown"}</strong>
            </div>
          </section>

          <section className="containers-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Core Infrastructure</p>
                <h2>Platform Services</h2>
              </div>

              <span className="container-count">
                {systemContainers.length} protected
              </span>
            </div>

            <div className="container-grid">
              {systemContainers.map(renderContainerCard)}
            </div>
          </section>

          <section className="containers-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Applications</p>
                <h2>Managed Apps</h2>
              </div>

              <button
                className="primary-button compact"
                onClick={() => {
                  setError("");
                  setNotice("");
                  setShowCreateApp(true);
                }}
              >
                Create App
              </button>
            </div>

            {managedApps.length === 0 ? (
              <div className="empty-state app-empty-state">
                <h3>No managed apps yet</h3>
                <p>
                  Deploy your first application from a Docker image.
                </p>

                <button
                  className="primary-button"
                  onClick={() => setShowCreateApp(true)}
                >
                  Deploy First App
                </button>
              </div>
            ) : (
              <div className="container-grid">
                {managedApps.map(renderContainerCard)}
              </div>
            )}
          </section>

          {otherContainers.length > 0 && (
            <section className="containers-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">External</p>
                  <h2>Other Containers</h2>
                </div>

                <span className="container-count">
                  {otherContainers.length} unmanaged
                </span>
              </div>

              <div className="container-grid">
                {otherContainers.map(renderContainerCard)}
              </div>
            </section>
          )}
        </>
      )}

      {showCreateApp && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!creatingApp) {
              setShowCreateApp(false);
            }
          }}
        >
          <section
            className="form-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="eyebrow">New Deployment</p>
                <h2>Create App</h2>
              </div>

              <button
                className="close-button"
                type="button"
                disabled={creatingApp}
                onClick={() => setShowCreateApp(false)}
              >
                Close
              </button>
            </header>

            <form onSubmit={(event) => void createApp(event)}>
              <label>
                <span>App name</span>
                <input
                  value={appName}
                  onChange={(event) => setAppName(event.target.value)}
                  placeholder="hello-nginx"
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  minLength={2}
                  maxLength={40}
                  required
                  autoFocus
                />
                <small>
                  Lowercase letters, numbers, and hyphens only.
                </small>
              </label>

              <label>
                <span>Docker image</span>
                <input
                  value={appImage}
                  onChange={(event) => setAppImage(event.target.value)}
                  placeholder="nginx:alpine"
                  required
                />
                <small>
                  Include a tag when possible, such as nginx:alpine.
                </small>
              </label>

              <label>
                <span>Container port</span>
                <input
                  type="number"
                  value={containerPort}
                  onChange={(event) =>
                    setContainerPort(event.target.value)
                  }
                  min="1"
                  max="65535"
                  required
                />
                <small>
                  The port the application listens on inside its container.
                </small>
              </label>

              <div className="form-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={creatingApp}
                  onClick={() => setShowCreateApp(false)}
                >
                  Cancel
                </button>

                <button
                  className="primary-button"
                  type="submit"
                  disabled={creatingApp}
                >
                  {creatingApp ? "Deploying..." : "Deploy App"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {selectedContainer && (
        <div
          className="modal-backdrop"
          onClick={() => setSelectedContainer(null)}
        >
          <section
            className="logs-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="eyebrow">Container Logs</p>
                <h2>
                  {selectedContainer.names[0] ??
                    selectedContainer.shortId}
                </h2>
              </div>

              <button
                className="close-button"
                onClick={() => setSelectedContainer(null)}
              >
                Close
              </button>
            </header>

            <pre>{logs}</pre>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
