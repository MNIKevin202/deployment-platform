import { useCallback, useEffect, useState } from "react";
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
}

interface LogsResponse {
  containerId: string;
  logs: string;
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

  const loadDashboard = useCallback(async () => {
    try {
      setError("");

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

      if (selectedContainer) {
        const updatedSelection = containerList.find(
          (container) => container.id === selectedContainer.id
        );

        setSelectedContainer(updatedSelection ?? null);
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load dashboard"
      );
    } finally {
      setLoading(false);
    }
  }, [selectedContainer]);

  useEffect(() => {
    void loadDashboard();

    const interval = window.setInterval(() => {
      void loadDashboard();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [loadDashboard]);

  const runAction = async (
    container: ContainerSummary,
    action: ContainerAction
  ) => {
    try {
      setError("");
      setActionLoading(`${container.id}:${action}`);

      const response = await fetch(
        `/api/containers/${container.id}/${action}`,
        {
          method: "POST"
        }
      );

      if (!response.ok) {
        throw new Error(`Unable to ${action} container`);
      }

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
        throw new Error("Unable to load container logs");
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

  const formatPorts = (ports: ContainerPort[]) => {
    if (ports.length === 0) {
      return "No published ports";
    }

    return ports
      .map((port) =>
        port.PublicPort
          ? `${port.PublicPort}:${port.PrivatePort}/${port.Type}`
          : `${port.PrivatePort}/${port.Type}`
      )
      .join(", ");
  };

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">Deployment Platform</p>
          <h1>Docker Dashboard</h1>
          <p className="subtitle">
            Monitor and control containers running on your server.
          </p>
        </div>

        <button className="refresh-button" onClick={() => void loadDashboard()}>
          Refresh
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <section className="empty-state">Loading Docker information...</section>
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
                <p className="eyebrow">Runtime</p>
                <h2>Containers</h2>
              </div>

              <span className="container-count">
                {containers.length} total
              </span>
            </div>

            {containers.length === 0 ? (
              <div className="empty-state">No containers found.</div>
            ) : (
              <div className="container-grid">
                {containers.map((container) => {
                  const isRunning = container.state === "running";

                  return (
                    <article className="container-card" key={container.id}>
                      <div className="container-card-header">
                        <div>
                          <h3>{container.names[0] ?? container.shortId}</h3>
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
                        {!isRunning && (
                          <button
                            onClick={() => void runAction(container, "start")}
                            disabled={
                              actionLoading === `${container.id}:start`
                            }
                          >
                            Start
                          </button>
                        )}

                        {isRunning && (
                          <button
                            onClick={() => void runAction(container, "stop")}
                            disabled={
                              actionLoading === `${container.id}:stop`
                            }
                          >
                            Stop
                          </button>
                        )}

                        <button
                          onClick={() => void runAction(container, "restart")}
                          disabled={
                            !isRunning ||
                            actionLoading === `${container.id}:restart`
                          }
                        >
                          Restart
                        </button>

                        <button onClick={() => void openLogs(container)}>
                          Logs
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
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
                <p className="eyebrow">Container logs</p>
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
