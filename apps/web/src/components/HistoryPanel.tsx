import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  Deployment,
  DeploymentsResponse,
  RevertResponse
} from "../types/api";
import ConfirmationDialog from "./ConfirmationDialog";

interface HistoryPanelProps {
  appId: number;
  /** Bubbled up so the parent can refresh the app's live status after a revert. */
  onReverted?: () => void;
  /** The app's current per-app retention override; null/undefined means the global default applies. */
  deploymentRetention?: number | null;
  /** Bubbled up so the parent can refresh after the override changes. */
  onRetentionChanged?: () => void;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null) {
    return "—";
  }

  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

export default function HistoryPanel({
  appId,
  onReverted,
  deploymentRetention,
  onRetentionChanged
}: HistoryPanelProps) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<Deployment | null>(null);
  const [reverting, setReverting] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");
  const [retentionInput, setRetentionInput] = useState(
    deploymentRetention == null ? "" : String(deploymentRetention)
  );
  const [savingRetention, setSavingRetention] = useState(false);

  const loadDeployments = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(`/api/apps/${appId}/deployments`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load deployment history"));
      }

      const result = (await response.json()) as DeploymentsResponse;
      setDeployments(result.deployments);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load deployment history");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void loadDeployments();
  }, [loadDeployments]);

  const saveRetention = async () => {
    try {
      setSavingRetention(true);
      setError("");
      setNotice("");

      const trimmed = retentionInput.trim();
      // Blank clears the override, restoring the global default.
      const retention = trimmed === "" ? null : Number(trimmed);

      const response = await fetch(`/api/apps/${appId}/retention`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention })
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to save retention"));
      }

      setNotice(
        retention === null
          ? "Using the global retention default for this app."
          : `Keeping the ${retention} most recent version${retention === 1 ? "" : "s"} for this app.`
      );
      onRetentionChanged?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save retention");
    } finally {
      setSavingRetention(false);
    }
  };

  const confirmRevert = async () => {
    if (!target) {
      return;
    }

    try {
      setReverting(true);
      setDialogError("");

      const response = await fetch(`/api/apps/${appId}/deployments/${target.version}/revert`, {
        method: "POST"
      });

      const result = (await response.json().catch(() => null)) as RevertResponse | null;

      if (!response.ok || !result?.success) {
        throw new Error(result?.message || (await readApiError(response, "Revert failed")));
      }

      setNotice(result.message);
      setTarget(null);
      await loadDeployments();
      onReverted?.();
    } catch (revertError) {
      setDialogError(revertError instanceof Error ? revertError.message : "Revert failed");
    } finally {
      setReverting(false);
    }
  };

  return (
    <div className="app-detail-tab-panel">
      <div className="env-scope-heading">
        <div>
          <h3>Version History</h3>
          <p className="text-faint">
            Recent deployments, newest first. Revert re-runs a previous build and records it as a new
            version.
          </p>
        </div>
        <div className="inline-field">
          <label className="text-faint" htmlFor={`retention-${appId}`}>
            Keep versions
          </label>
          <input
            id={`retention-${appId}`}
            type="number"
            className="wizard-input compact"
            min={1}
            max={50}
            placeholder="default"
            value={retentionInput}
            onChange={(event) => setRetentionInput(event.target.value)}
            aria-label="Rollback versions to keep for this app"
          />
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void saveRetention()}
            disabled={savingRetention}
          >
            {savingRetention ? "Saving…" : "Save"}
          </button>
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void loadDeployments()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      {loading && deployments.length === 0 ? (
        <div className="empty-state">Loading deployment history...</div>
      ) : deployments.length === 0 ? (
        <div className="empty-state">No deployments recorded for this app yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="env-table history-table">
            <thead>
              <tr>
                <th>State</th>
                <th>Version</th>
                <th>Deploy Time</th>
                <th>Duration</th>
                <th>Image</th>
                <th>Commit</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((deployment) => (
                <tr key={deployment.id} className={deployment.isCurrent ? "history-row-current" : undefined}>
                  <td>
                    {deployment.isCurrent ? (
                      <span className="status-badge compact positive" title="Current deployment">
                        ✓ Live
                      </span>
                    ) : deployment.canRevert ? (
                      <button
                        className="icon-button revert-button"
                        type="button"
                        title={`Revert to version ${deployment.version}`}
                        aria-label={`Revert to version ${deployment.version}`}
                        onClick={() => {
                          setDialogError("");
                          setNotice("");
                          setTarget(deployment);
                        }}
                      >
                        ↻
                      </button>
                    ) : (
                      <span className="text-faint" aria-hidden="true">
                        —
                      </span>
                    )}
                  </td>
                  <td>
                    v{deployment.version}
                    {deployment.revertOfVersion !== null && (
                      <span className="text-faint"> (revert of v{deployment.revertOfVersion})</span>
                    )}
                  </td>
                  <td className="text-faint">{formatDate(deployment.createdAt)}</td>
                  <td className="text-faint">{formatDuration(deployment.durationMs)}</td>
                  <td>
                    <code className="inline-code">{deployment.imageTag}</code>
                  </td>
                  <td className="text-faint" title={deployment.commitMessage ?? undefined}>
                    {shortSha(deployment.commitSha)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmationDialog
        open={target !== null}
        title="Revert deployment"
        message={
          target ? (
            <>
              Redeploy <strong>version {target.version}</strong> ({shortSha(target.commitSha)})? This
              re-runs that build and appends it as a new current version. Your other versions stay in
              the history.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Revert"
        confirmingLabel="Reverting..."
        confirming={reverting}
        error={dialogError}
        onConfirm={() => void confirmRevert()}
        onCancel={() => {
          if (!reverting) {
            setTarget(null);
          }
        }}
      />
    </div>
  );
}
