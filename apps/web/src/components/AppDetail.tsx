import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  AppDetail as AppDetailData,
  ContainerAction,
  EffectiveEnvVar,
  EnvVarFormValues,
  MaskedAppEnvVar,
  MaskedGlobalEnvVar
} from "../types/api";
import StatusBadge from "./StatusBadge";
import ConfirmationDialog from "./ConfirmationDialog";
import LogViewer from "./LogViewer";
import Tabs from "./Tabs";
import EnvVarTable from "./EnvVarTable";
import EnvVarDialog from "./EnvVarDialog";

interface AppDetailProps {
  appId: number;
  onBack: () => void;
  onDeleted: () => void;
  onAppChanged: () => void;
  onGoToGlobalEnvironment: () => void;
}

type DetailTab = "overview" | "environment" | "logs";

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
  onAppChanged,
  onGoToGlobalEnvironment
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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

  const [appVars, setAppVars] = useState<MaskedAppEnvVar[]>([]);
  const [globalVars, setGlobalVars] = useState<MaskedGlobalEnvVar[]>([]);
  const [effectiveVars, setEffectiveVars] = useState<EffectiveEnvVar[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);
  const [envLoading, setEnvLoading] = useState(false);
  const [envError, setEnvError] = useState("");

  const [showEnvDialog, setShowEnvDialog] = useState(false);
  const [editingVar, setEditingVar] = useState<MaskedAppEnvVar | null>(null);
  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [envSubmitting, setEnvSubmitting] = useState(false);
  const [envDialogError, setEnvDialogError] = useState("");
  const [envDeleteTarget, setEnvDeleteTarget] = useState<MaskedAppEnvVar | null>(
    null
  );
  const [envDeleting, setEnvDeleting] = useState(false);

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

  const loadEnvironment = useCallback(async () => {
    try {
      setEnvLoading(true);
      setEnvError("");

      const [appVarsResponse, globalVarsResponse, effectiveResponse] =
        await Promise.all([
          fetch(`/api/apps/${appId}/environment`),
          fetch("/api/environment/global"),
          fetch(`/api/apps/${appId}/environment/effective`)
        ]);

      if (!appVarsResponse.ok || !globalVarsResponse.ok || !effectiveResponse.ok) {
        throw new Error("Unable to load environment variables");
      }

      const appVarsResult = (await appVarsResponse.json()) as {
        variables: MaskedAppEnvVar[];
      };
      const globalVarsResult = (await globalVarsResponse.json()) as {
        variables: MaskedGlobalEnvVar[];
      };
      const effectiveResult = (await effectiveResponse.json()) as {
        variables: EffectiveEnvVar[];
      };

      setAppVars(appVarsResult.variables);
      setGlobalVars(globalVarsResult.variables);
      setEffectiveVars(effectiveResult.variables);
      setEnvLoaded(true);
    } catch (error) {
      setEnvError(
        error instanceof Error
          ? error.message
          : "Unable to load environment variables"
      );
    } finally {
      setEnvLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if (activeTab === "environment" && !envLoaded) {
      void loadEnvironment();
    }
  }, [activeTab, envLoaded, loadEnvironment]);

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

  const openCreateEnvDialog = () => {
    setEditingVar(null);
    setOverrideKey(null);
    setEnvDialogError("");
    setShowEnvDialog(true);
  };

  const openOverrideDialog = (globalVar: EffectiveEnvVar) => {
    setEditingVar(null);
    setOverrideKey(globalVar.key);
    setEnvDialogError("");
    setShowEnvDialog(true);
  };

  const openEditEnvDialog = (variable: MaskedAppEnvVar) => {
    setEditingVar(variable);
    setOverrideKey(null);
    setEnvDialogError("");
    setShowEnvDialog(true);
  };

  const submitEnvDialog = async (values: EnvVarFormValues) => {
    try {
      setEnvSubmitting(true);
      setEnvDialogError("");

      if (editingVar) {
        const body: Partial<EnvVarFormValues> = {
          isSecret: values.isSecret,
          enabled: values.enabled
        };

        if (!(editingVar.isSecret && values.value === "")) {
          body.value = values.value;
        }

        const response = await fetch(
          `/api/apps/${appId}/environment/${editingVar.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          }
        );

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to update variable")
          );
        }

        setNotice(`${editingVar.key} was updated.`);
      } else {
        const response = await fetch(`/api/apps/${appId}/environment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values)
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to create variable")
          );
        }

        setNotice(`${values.key} was added.`);
      }

      setShowEnvDialog(false);
      await loadEnvironment();
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setEnvDialogError(
        error instanceof Error ? error.message : "Unable to save variable"
      );
    } finally {
      setEnvSubmitting(false);
    }
  };

  const confirmEnvDelete = async () => {
    if (!envDeleteTarget) {
      return;
    }

    try {
      setEnvDeleting(true);

      const response = await fetch(
        `/api/apps/${appId}/environment/${envDeleteTarget.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to delete variable")
        );
      }

      setNotice(`${envDeleteTarget.key} was deleted.`);
      setEnvDeleteTarget(null);
      await loadEnvironment();
      await loadDetail();
      onAppChanged();
    } catch (error) {
      setEnvError(
        error instanceof Error ? error.message : "Unable to delete variable"
      );
      setEnvDeleteTarget(null);
    } finally {
      setEnvDeleting(false);
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
  const isEnvPending = detail.environmentStatus === "pending";
  const inheritedGlobals = effectiveVars.filter((v) => v.source === "global");

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
          <StatusBadge
            label={isEnvPending ? "Changes Pending" : "Env Applied"}
            tone={isEnvPending ? "warning" : "positive"}
          />
        </div>

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

          {detail.containerExists && (
            <button
              type="button"
              onClick={() => void runAction("restart")}
              disabled={!isRunning || actionLoading !== null}
            >
              {actionLoading === "restart" ? "Restarting..." : "Restart"}
            </button>
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
              className="danger-button"
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={actionLoading !== null}
            >
              Delete
            </button>
          )}
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

      <Tabs
        items={[
          { key: "overview", label: "Overview" },
          { key: "environment", label: "Environment" },
          { key: "logs", label: "Logs" }
        ]}
        active={activeTab}
        onChange={(key) => setActiveTab(key as DetailTab)}
      />

      {activeTab === "overview" && (
        <div className="app-detail-tab-panel">
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
        </div>
      )}

      {activeTab === "environment" && (
        <div className="app-detail-tab-panel">
          {envError && <div className="error-banner">{envError}</div>}

          <div className="env-scope-block">
            <div className="env-scope-heading">
              <h3>Effective Environment</h3>
              <StatusBadge
                label={isEnvPending ? "Changes Pending" : "Applied"}
                tone={isEnvPending ? "warning" : "positive"}
              />
            </div>
            <p className="section-description">
              {isEnvPending
                ? "Saved, but not active in the running container yet. Restarting will not apply these changes — the app must be redeployed or recreated, which isn't available yet in this version of the platform."
                : "The running container reflects the variables below."}
            </p>
          </div>

          {envLoading && !envLoaded ? (
            <div className="empty-state">Loading environment variables...</div>
          ) : (
            <>
              <div className="env-scope-block">
                <div className="env-scope-heading">
                  <h3>Inherited from Global</h3>
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={onGoToGlobalEnvironment}
                  >
                    Manage Global Variables
                  </button>
                </div>

                {inheritedGlobals.length === 0 ? (
                  <div className="empty-state">
                    No enabled global variables are currently inherited.
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table className="env-table">
                      <thead>
                        <tr>
                          <th>Key</th>
                          <th>Value</th>
                          <th aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {inheritedGlobals.map((variable) => (
                          <tr key={variable.key}>
                            <td className="env-key-cell">
                              <code>{variable.key}</code>
                              {variable.isSecret && (
                                <span className="status-badge warning compact">
                                  Secret
                                </span>
                              )}
                              <span className="env-source-badge global">
                                Global
                              </span>
                            </td>
                            <td className="env-value-cell">
                              {variable.isSecret ? (
                                variable.hasValue ? (
                                  <span className="masked-value">••••••••</span>
                                ) : (
                                  <span className="text-faint">Not set</span>
                                )
                              ) : variable.hasValue ? (
                                <code>{variable.value}</code>
                              ) : (
                                <span className="text-faint">Empty</span>
                              )}
                            </td>
                            <td className="env-actions-cell">
                              <button
                                className="secondary-button compact"
                                type="button"
                                onClick={() => openOverrideDialog(variable)}
                              >
                                Override
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="env-scope-block">
                <div className="env-scope-heading">
                  <h3>App-Specific Variables</h3>
                  <button
                    className="primary-button compact"
                    type="button"
                    onClick={openCreateEnvDialog}
                  >
                    Add Variable
                  </button>
                </div>

                <EnvVarTable
                  variables={appVars}
                  emptyMessage="No app-specific variables yet. Add one, or override a global variable above."
                  onEdit={(variable) =>
                    openEditEnvDialog(variable as MaskedAppEnvVar)
                  }
                  onDelete={(variable) =>
                    setEnvDeleteTarget(variable as MaskedAppEnvVar)
                  }
                  busyId={envDeleting ? envDeleteTarget?.id ?? null : null}
                />

                {appVars.some((variable) =>
                  globalVars.some((globalVar) => globalVar.key === variable.key)
                ) && (
                  <p className="section-description">
                    Variables marked as overriding a global key take priority
                    over the inherited value for this app only.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "logs" && (
        <div className="app-detail-tab-panel">
          {detail.containerId ? (
            <LogViewer
              containerId={detail.containerId}
              title={detail.name}
              variant="inline"
            />
          ) : (
            <div className="empty-state">
              Logs are unavailable because the container does not exist.
            </div>
          )}
        </div>
      )}

      <EnvVarDialog
        open={showEnvDialog}
        title={
          editingVar
            ? `Edit ${editingVar.key}`
            : overrideKey
              ? `Override ${overrideKey}`
              : "Add App Variable"
        }
        description={
          overrideKey
            ? `This creates an app-specific value for "${overrideKey}" that takes priority over the global value.`
            : undefined
        }
        keyLocked={editingVar !== null || overrideKey !== null}
        initialValues={
          editingVar
            ? {
                key: editingVar.key,
                value: "",
                isSecret: editingVar.isSecret,
                enabled: editingVar.enabled
              }
            : overrideKey
              ? { key: overrideKey, value: "", isSecret: false, enabled: true }
              : undefined
        }
        secretValuePlaceholder={
          editingVar?.isSecret
            ? "Leave blank to keep the current secret value"
            : undefined
        }
        submitting={envSubmitting}
        error={envDialogError}
        onSubmit={(values) => void submitEnvDialog(values)}
        onCancel={() => setShowEnvDialog(false)}
      />

      <ConfirmationDialog
        open={envDeleteTarget !== null}
        title={`Delete ${envDeleteTarget?.key}?`}
        message={
          <p>
            This removes <strong>{envDeleteTarget?.key}</strong> from this
            app. If it was overriding a global variable, the app will fall
            back to the global value after redeploy.
          </p>
        }
        confirmLabel="Delete variable"
        danger
        confirming={envDeleting}
        onConfirm={() => void confirmEnvDelete()}
        onCancel={() => setEnvDeleteTarget(null)}
      />

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
