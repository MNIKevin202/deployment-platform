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

export default function HistoryPanel({ appId, onReverted }: HistoryPanelProps) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<Deployment | null>(null);
  const [reverting, setReverting] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");

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
        <button
          className="secondary-button compact"
          type="button"
          onClick={() => void loadDeployments()}
          disabled={loading}
        >
          Refresh
        </button>
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
