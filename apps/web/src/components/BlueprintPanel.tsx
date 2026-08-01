import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiError,
  BlueprintPullResponse,
  BlueprintStatus,
  BlueprintStatusResponse
} from "../types/api";
import { BLUEPRINT_MODEL_CHOICES } from "../lib/appTemplates";
import ConfirmationDialog from "./ConfirmationDialog";

interface BlueprintPanelProps {
  appId: number;
  containerRunning: boolean;
}

/** How often to re-read status while a model download is in flight. */
const PULL_POLL_MS = 2000;

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export default function BlueprintPanel({ appId, containerRunning }: BlueprintPanelProps) {
  const [status, setStatus] = useState<BlueprintStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [model, setModel] = useState(BLUEPRINT_MODEL_CHOICES[2]?.id ?? "llama3.2:3b");
  const [customModel, setCustomModel] = useState("");
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [pullError, setPullError] = useState("");
  const [pullNotice, setPullNotice] = useState("");
  const [pulling, setPulling] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  // A ref, not state, so the poller below always reads the current value
  // without needing to be torn down and rebuilt on every status refresh.
  const pullRunningRef = useRef(false);

  const loadStatus = useCallback(async () => {
    setError("");

    try {
      const response = await fetch(`/api/apps/${appId}/blueprint/status`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load Blueprint status"));
      }

      const result = (await response.json()) as BlueprintStatusResponse;
      setStatus(result.status ?? null);
      pullRunningRef.current = result.status?.pull?.status === "running";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load Blueprint status");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if (!containerRunning) {
      setLoading(false);
      return;
    }
    void loadStatus();
  }, [containerRunning, loadStatus]);

  // While a download is running, keep refreshing so progress advances on
  // screen. The interval is torn down as soon as nothing is running, so an
  // idle panel makes no background requests at all.
  useEffect(() => {
    if (!containerRunning || status?.pull?.status !== "running") {
      return;
    }

    const timer = window.setInterval(() => {
      void loadStatus();
    }, PULL_POLL_MS);

    return () => window.clearInterval(timer);
  }, [containerRunning, status?.pull?.status, loadStatus]);

  const startPull = async () => {
    const target = (useCustomModel ? customModel : model).trim();

    if (!target) {
      setPullError("Choose a model to download.");
      return;
    }

    setPulling(true);
    setPullError("");
    setPullNotice("");

    try {
      const response = await fetch(`/api/apps/${appId}/blueprint/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: target })
      });

      const result = (await response.json().catch(() => ({}))) as Partial<BlueprintPullResponse>;

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to start the download");
      }

      setPullNotice(result.message ?? "Download started.");
      await loadStatus();
    } catch (caught) {
      setPullError(caught instanceof Error ? caught.message : "Unable to start the download");
    } finally {
      setPulling(false);
    }
  };

  const deleteModel = async (name: string) => {
    setDeleting(true);
    setPullError("");
    setPullNotice("");

    try {
      const response = await fetch(`/api/apps/${appId}/blueprint/models`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: name })
      });

      const result = (await response.json().catch(() => ({}))) as Partial<BlueprintPullResponse>;

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to delete the model");
      }

      setPullNotice(result.message ?? `Model "${name}" was deleted.`);
      await loadStatus();
    } catch (caught) {
      setPullError(caught instanceof Error ? caught.message : "Unable to delete the model");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const copyInternalUrl = async () => {
    if (!status) {
      return;
    }
    try {
      await navigator.clipboard.writeText(status.modelServerUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setPullError("Unable to copy to the clipboard. Select and copy the URL manually.");
    }
  };

  if (!containerRunning) {
    return (
      <div className="empty-state">
        The container is not running, so Blueprint can't be managed right now.
      </div>
    );
  }

  if (loading) {
    return <div className="empty-state">Loading Blueprint status…</div>;
  }

  if (error) {
    return <div className="error-banner">{error}</div>;
  }

  if (!status) {
    return <div className="empty-state">No Blueprint status is available.</div>;
  }

  const pull = status.pull;
  const noModels = status.models.length === 0;

  return (
    <div className="blueprint-panel">
      <div className="env-scope-block">
        <div className="env-scope-heading">
          <h3>Blueprint</h3>
          {status.webDomain && (
            <a
              className="primary-button compact"
              href={`https://${status.webDomain}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open Blueprint
            </a>
          )}
        </div>

        <dl className="wizard-review-grid">
          <div>
            <dt>Chat interface</dt>
            <dd>
              <span className={`status-badge ${status.webRunning ? "positive" : "warning"}`}>
                {status.webRunning ? "Running" : "Stopped"}
              </span>
            </dd>
          </div>
          <div>
            <dt>Model server</dt>
            <dd>
              <span
                className={`status-badge ${
                  status.modelServerRunning && status.modelServerReachable ? "positive" : "warning"
                }`}
              >
                {!status.modelServerRunning
                  ? "Stopped"
                  : status.modelServerReachable
                    ? "Running"
                    : "Not responding"}
              </span>
              {status.version && <span className="text-faint"> Ollama {status.version}</span>}
            </dd>
          </div>
          <div>
            <dt>Installed models</dt>
            <dd>{status.models.length}</dd>
          </div>
          <div>
            <dt>Model storage used</dt>
            <dd>{formatBytes(status.modelStorageBytes)}</dd>
          </div>
        </dl>

        <div className="template-connect">
          <span className="template-connect-label">Model server (private, not on the internet)</span>
          <code>{status.modelServerUrl}</code>
          <button className="secondary-button compact" type="button" onClick={() => void copyInternalUrl()}>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>

        <div className="warning-banner">
          Blueprint runs AI models on your VPS CPU. Responses may generate gradually, especially on
          smaller servers. Recommended: 6+ vCPU, 8 GB RAM, 20 GB storage.
        </div>

        {status.modelError && <div className="error-banner">{status.modelError}</div>}
      </div>

      <div className="env-scope-block">
        <div className="env-scope-heading">
          <h3>Models</h3>
        </div>

        {noModels && !pull && (
          <div className="warning-banner">
            No models are installed yet, so Blueprint has nothing to answer with. Download one
            below to get started.
          </div>
        )}

        {pull && (
          <div
            className={
              pull.status === "failed"
                ? "error-banner"
                : pull.status === "succeeded"
                  ? "notice-banner"
                  : "notice-banner"
            }
          >
            <strong>{pull.model}</strong>{" "}
            {pull.status === "running"
              ? `— ${pull.detail}${pull.percent !== null ? ` (${pull.percent}%)` : ""}`
              : pull.status === "succeeded"
                ? "— download complete."
                : `— download failed: ${pull.error ?? "unknown error"}. You can try again below.`}
          </div>
        )}

        {status.models.length > 0 && (
          <div className="wizard-row-list">
            {status.models.map((installed) => (
              <div className="wizard-row" key={installed.name}>
                <div className="wizard-row-fields">
                  <div>
                    <strong>{installed.name}</strong>
                    <span className="text-faint">
                      {formatBytes(installed.size)}
                      {installed.parameterSize ? ` · ${installed.parameterSize}` : ""}
                      {installed.quantization ? ` · ${installed.quantization}` : ""}
                    </span>
                  </div>
                </div>
                <div className="wizard-row-actions">
                  <button
                    className="danger-button compact"
                    type="button"
                    disabled={deleting}
                    onClick={() => setDeleteTarget(installed.name)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="env-scope-heading published-ports-heading">
          <h3>Download a model</h3>
        </div>

        <label>
          <span>Model</span>
          {useCustomModel ? (
            <input
              value={customModel}
              onChange={(event) => setCustomModel(event.target.value)}
              placeholder="llama3.2:3b"
              autoComplete="off"
            />
          ) : (
            <select
              className="wizard-select"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              aria-label="Model to download"
            >
              {BLUEPRINT_MODEL_CHOICES.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label} · {choice.sizeLabel}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={useCustomModel}
            onChange={(event) => setUseCustomModel(event.target.checked)}
          />
          <span>Enter another model name from Ollama's library</span>
        </label>

        {pullError && <div className="error-banner">{pullError}</div>}
        {pullNotice && !pullError && <div className="notice-banner">{pullNotice}</div>}

        <div className="form-actions form-actions-start">
          <button
            className="primary-button"
            type="button"
            disabled={pulling || pull?.status === "running" || !status.modelServerRunning}
            onClick={() => void startPull()}
          >
            {pulling
              ? "Starting…"
              : pull?.status === "running"
                ? "Download in progress…"
                : pull?.status === "failed"
                  ? "Retry download"
                  : "Download model"}
          </button>
        </div>

        <p className="section-description">
          Downloads run in the background on the server and continue even if you close this page.
          Only one download runs at a time. Models stay on their own storage volume, so they
          survive restarts and redeploys.
        </p>
      </div>

      <ConfirmationDialog
        open={deleteTarget !== null}
        title="Delete model"
        message={`Delete "${deleteTarget}" from the model server? This frees its disk space. You can download it again later.`}
        confirmLabel="Delete Model"
        confirmingLabel="Deleting…"
        danger
        confirming={deleting}
        onConfirm={() => {
          if (deleteTarget) {
            void deleteModel(deleteTarget);
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
