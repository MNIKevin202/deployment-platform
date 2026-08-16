import { useCallback, useEffect, useState } from "react";
import ConnectionDialog, {
  CONNECTION_KIND_OPTIONS
} from "../components/ConnectionDialog";
import ConfirmationDialog from "../components/ConfirmationDialog";
import type {
  ApiError,
  ConnectionFormValues,
  DatabaseConnectionKind,
  MaskedDatabaseConnection
} from "../types/api";

interface ConnectionsResponse {
  connections: MaskedDatabaseConnection[];
}

interface ConnectionsPageProps {
  /** Bumped by the header's Refresh button to trigger a reload. */
  refreshKey?: number;
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

function kindLabel(kind: DatabaseConnectionKind): string {
  return (
    CONNECTION_KIND_OPTIONS.find((option) => option.value === kind)?.label ??
    kind
  );
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function ConnectionsPage({ refreshKey = 0 }: ConnectionsPageProps) {
  const [connections, setConnections] = useState<MaskedDatabaseConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");

  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<MaskedDatabaseConnection | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [deleteTarget, setDeleteTarget] =
    useState<MaskedDatabaseConnection | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");

      const response = await fetch("/api/connections");

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to load connections")
        );
      }

      const result = (await response.json()) as ConnectionsResponse;
      setConnections(result.connections);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to load connections"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections, refreshKey]);

  const openCreateDialog = () => {
    setEditing(null);
    setDialogError("");
    setShowDialog(true);
  };

  const openEditDialog = (connection: MaskedDatabaseConnection) => {
    setEditing(connection);
    setDialogError("");
    setShowDialog(true);
  };

  const pushToGlobal = useCallback(
    async (id: number): Promise<boolean> => {
      const response = await fetch(`/api/connections/${id}/push-to-global`, {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to add connection to the global environment")
        );
      }
      return true;
    },
    []
  );

  const submitDialog = async (values: ConnectionFormValues) => {
    try {
      setSubmitting(true);
      setDialogError("");

      const trimmedKey = values.envKey.trim();
      let connectionId: number;

      if (editing) {
        const body: Record<string, unknown> = {
          name: values.name,
          kind: values.kind,
          envKey: trimmedKey
        };
        // An empty string on edit means "keep the stored connection string".
        if (values.connectionString !== "") {
          body.connectionString = values.connectionString;
        }

        const response = await fetch(`/api/connections/${editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to update connection")
          );
        }

        connectionId = editing.id;
        setNotice(`${values.name} was updated.`);
      } else {
        const response = await fetch("/api/connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: values.name,
            kind: values.kind,
            connectionString: values.connectionString,
            envKey: trimmedKey
          })
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to create connection")
          );
        }

        const result = (await response.json()) as {
          connection: MaskedDatabaseConnection;
        };
        connectionId = result.connection.id;
        setNotice(`${values.name} was added.`);
      }

      if (values.injectGlobally && trimmedKey !== "") {
        await pushToGlobal(connectionId);
        setNotice(`${values.name} was saved and shared with every app as ${trimmedKey}.`);
      }

      setShowDialog(false);
      await loadConnections();
    } catch (error) {
      setDialogError(
        error instanceof Error ? error.message : "Unable to save connection"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const copyConnection = async (connection: MaskedDatabaseConnection) => {
    try {
      setBusyId(connection.id);
      setLoadError("");

      const response = await fetch(`/api/connections/${connection.id}/reveal`);
      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to read connection string")
        );
      }

      const result = (await response.json()) as { connectionString: string };
      await navigator.clipboard.writeText(result.connectionString);

      setCopiedId(connection.id);
      window.setTimeout(
        () => setCopiedId((current) => (current === connection.id ? null : current)),
        1500
      );
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to copy connection string"
      );
    } finally {
      setBusyId(null);
    }
  };

  const shareToApps = async (connection: MaskedDatabaseConnection) => {
    try {
      setBusyId(connection.id);
      setLoadError("");
      await pushToGlobal(connection.id);
      setNotice(`${connection.name} is now shared with every app as ${connection.envKey}.`);
      await loadConnections();
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to share connection"
      );
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return;
    }

    try {
      setDeleting(true);

      const response = await fetch(`/api/connections/${deleteTarget.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to delete connection")
        );
      }

      setNotice(`${deleteTarget.name} was deleted.`);
      setDeleteTarget(null);
      await loadConnections();
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to delete connection"
      );
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page">
      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Connections</p>
            <h2>Database Connections</h2>
            <p className="section-description">
              Keep the connection strings for databases you host elsewhere —
              MongoDB Atlas, a managed Postgres, an external Redis — in one
              place. Copy them on demand, or share one with every app as a
              secret environment variable.
            </p>
          </div>

          <button className="primary-button compact" type="button" onClick={openCreateDialog}>
            Add Connection
          </button>
        </div>

        {notice && <div className="notice-banner">{notice}</div>}
        {loadError && <div className="error-banner">{loadError}</div>}

        {loading ? (
          <div className="empty-state">Loading connections...</div>
        ) : connections.length === 0 ? (
          <div className="empty-state">
            No connections yet. Add one to store a connection string you can copy
            or push into every app.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="env-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Connection</th>
                  <th>Variable</th>
                  <th>Updated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {connections.map((connection) => (
                  <tr key={connection.id}>
                    <td className="env-key-cell">
                      <strong>{connection.name}</strong>
                      <span className="status-badge neutral compact">
                        {kindLabel(connection.kind)}
                      </span>
                    </td>
                    <td className="env-value-cell">
                      <code className="connection-preview">{connection.preview}</code>
                      <button
                        className="secondary-button compact"
                        type="button"
                        onClick={() => void copyConnection(connection)}
                        disabled={busyId === connection.id}
                      >
                        {copiedId === connection.id ? "Copied!" : "Copy"}
                      </button>
                    </td>
                    <td>
                      {connection.envKey ? (
                        <div className="stacked-cell">
                          <code>{connection.envKey}</code>
                          {connection.inGlobalEnv ? (
                            <span className="status-badge positive compact">
                              In every app
                            </span>
                          ) : (
                            <button
                              className="secondary-button compact"
                              type="button"
                              onClick={() => void shareToApps(connection)}
                              disabled={busyId === connection.id}
                            >
                              Add to apps
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-faint">Copy-only</span>
                      )}
                    </td>
                    <td className="text-faint">{formatDate(connection.updatedAt)}</td>
                    <td className="env-actions-cell">
                      <button
                        className="secondary-button compact"
                        type="button"
                        onClick={() => openEditDialog(connection)}
                        disabled={busyId === connection.id}
                      >
                        Edit
                      </button>
                      <button
                        className="danger-button compact"
                        type="button"
                        onClick={() => setDeleteTarget(connection)}
                        disabled={busyId === connection.id}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConnectionDialog
        open={showDialog}
        title={editing ? `Edit ${editing.name}` : "Add Database Connection"}
        editing={editing !== null}
        initialValues={
          editing
            ? {
                name: editing.name,
                kind: editing.kind,
                connectionString: "",
                envKey: editing.envKey ?? "",
                injectGlobally: editing.inGlobalEnv
              }
            : undefined
        }
        submitting={submitting}
        error={dialogError}
        onSubmit={(values) => void submitDialog(values)}
        onCancel={() => setShowDialog(false)}
      />

      <ConfirmationDialog
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget?.name}?`}
        message={
          <p>
            This removes the stored connection <strong>{deleteTarget?.name}</strong>.
            Any global variable already pushed from it stays in place — remove
            that separately from the Environment page if you no longer need it.
          </p>
        }
        confirmLabel="Delete connection"
        danger
        confirming={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
