import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  HealthCheckFormValues,
  HealthCheckInfo,
  HealthCheckOutcome,
  HealthCheckResponse,
  RunHealthCheckResponse
} from "../types/api";
import StatusBadge from "./StatusBadge";

interface HealthPanelProps {
  appId: number;
  containerRunning: boolean;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

const STATE_LABELS: Record<string, string> = {
  disabled: "Disabled",
  unknown: "Unknown",
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  checking: "Checking...",
  "container-not-running": "Container Not Running",
  error: "Error"
};

const STATE_TONES: Record<string, "positive" | "negative" | "neutral" | "warning"> = {
  disabled: "neutral",
  unknown: "neutral",
  healthy: "positive",
  unhealthy: "negative",
  checking: "warning",
  "container-not-running": "negative",
  error: "negative"
};

function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function toFormValues(health: HealthCheckInfo): HealthCheckFormValues {
  return {
    enabled: health.enabled,
    path: health.path,
    expectedStatus: health.expectedStatus,
    intervalSeconds: health.intervalSeconds,
    timeoutSeconds: health.timeoutSeconds,
    failureThreshold: health.failureThreshold,
    successThreshold: health.successThreshold
  };
}

export default function HealthPanel({ appId, containerRunning }: HealthPanelProps) {
  const [health, setHealth] = useState<HealthCheckInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [showEditor, setShowEditor] = useState(false);
  const [formValues, setFormValues] = useState<HealthCheckFormValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastTestResult, setLastTestResult] = useState<HealthCheckOutcome | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");

      const response = await fetch(`/api/apps/${appId}/health`);

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load health check"));
      }

      const result = (await response.json()) as HealthCheckResponse;
      setHealth(result.health);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load health check");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const openEditor = () => {
    if (health) {
      setFormValues(toFormValues(health));
    }
    setSaveError("");
    setShowEditor(true);
  };

  const submitEditor = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!formValues) {
      return;
    }

    try {
      setSaving(true);
      setSaveError("");

      const response = await fetch(`/api/apps/${appId}/health`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formValues)
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to save health check"));
      }

      const result = (await response.json()) as HealthCheckResponse;
      setHealth(result.health);
      setShowEditor(false);
      setNotice("Health check configuration saved.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save health check");
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    if (!health) {
      return;
    }

    try {
      setSaving(true);
      setSaveError("");

      const response = await fetch(`/api/apps/${appId}/health`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...toFormValues(health), enabled: !health.enabled })
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to update health check"));
      }

      const result = (await response.json()) as HealthCheckResponse;
      setHealth(result.health);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "Unable to update health check");
    } finally {
      setSaving(false);
    }
  };

  const runCheckNow = async () => {
    try {
      setChecking(true);
      setCheckError("");
      setNotice("");
      setLastTestResult(null);

      const response = await fetch(`/api/apps/${appId}/health/check`, {
        method: "POST"
      });

      const result = (await response
        .json()
        .catch(() => ({}))) as Partial<RunHealthCheckResponse>;

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to run health check");
      }

      if (result.health) {
        setHealth(result.health);
      }

      if (result.outcome?.persisted === false) {
        // Monitoring is disabled — the probe ran for real, but nothing was
        // saved and the configuration stays "disabled". Show the one-off
        // result separately rather than implying it changed anything.
        setLastTestResult(result.outcome);
        setNotice("");
      } else {
        setNotice("Health check ran successfully.");
      }
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "Unable to run health check");
    } finally {
      setChecking(false);
    }
  };

  if (loading && !health) {
    return <div className="empty-state">Loading health check...</div>;
  }

  if (loadError) {
    return <div className="error-banner">{loadError}</div>;
  }

  if (!health) {
    return null;
  }

  const stateLabel = checking ? STATE_LABELS.checking : STATE_LABELS[health.state] ?? health.state;
  const stateTone = checking ? STATE_TONES.checking : STATE_TONES[health.state] ?? "neutral";

  return (
    <div className="app-detail-tab-panel">
      {checkError && <div className="error-banner">{checkError}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="env-scope-block">
        <div className="env-scope-heading">
          <h3>Health Check</h3>
          <div className="container-actions">
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => void toggleEnabled()}
              disabled={saving}
            >
              {health.enabled ? "Disable" : "Enable"}
            </button>
            <button
              className="secondary-button compact"
              type="button"
              onClick={openEditor}
            >
              Edit Health Check
            </button>
            <button
              className="primary-button compact"
              type="button"
              onClick={() => void runCheckNow()}
              disabled={checking || !health.configured}
            >
              {checking ? "Checking..." : "Run Check Now"}
            </button>
          </div>
        </div>

        <p className="section-description">
          {containerRunning
            ? "A running container is not automatically healthy — health reflects the configured HTTP check below."
            : "The container is not running, so no health check can be performed right now."}
          {health.configured && !health.enabled && (
            <>
              {" "}
              Automatic monitoring is disabled. Run Check Now still performs a real
              test of the path below, but the result is shown for reference only and
              is not saved — the configuration stays disabled.
            </>
          )}
        </p>

        {lastTestResult && (
          <div className="notice-banner">
            Test result (not saved): <StatusBadge
              label={STATE_LABELS[lastTestResult.state ?? "unknown"] ?? lastTestResult.state ?? "Unknown"}
              tone={STATE_TONES[lastTestResult.state ?? "unknown"] ?? "neutral"}
            />
            {lastTestResult.statusCode !== undefined && lastTestResult.statusCode !== null && (
              <> — status {lastTestResult.statusCode}</>
            )}
            {lastTestResult.latencyMs !== undefined && lastTestResult.latencyMs !== null && (
              <> — {lastTestResult.latencyMs}ms</>
            )}
            {lastTestResult.errorMessage && <> — {lastTestResult.errorMessage}</>}
          </div>
        )}

        <div className="wizard-review-grid">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusBadge label={stateLabel} tone={stateTone} />
            </dd>
          </div>
          <div>
            <dt>Configured</dt>
            <dd>{health.configured ? "Yes" : "Not yet configured"}</dd>
          </div>
          <div>
            <dt>Path</dt>
            <dd>
              <code>{health.path}</code>
            </dd>
          </div>
          <div>
            <dt>Expected status</dt>
            <dd>{health.expectedStatus}</dd>
          </div>
          <div>
            <dt>Interval</dt>
            <dd>{health.intervalSeconds}s</dd>
          </div>
          <div>
            <dt>Timeout</dt>
            <dd>{health.timeoutSeconds}s</dd>
          </div>
          <div>
            <dt>Thresholds</dt>
            <dd>
              {health.successThreshold} success / {health.failureThreshold} failure
            </dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>{formatDate(health.lastCheckedAt)}</dd>
          </div>
          <div>
            <dt>Last successful check</dt>
            <dd>{formatDate(health.lastSuccessAt)}</dd>
          </div>
          <div>
            <dt>Last failure</dt>
            <dd>{formatDate(health.lastFailureAt)}</dd>
          </div>
          <div>
            <dt>Last response status</dt>
            <dd>{health.lastStatusCode ?? "—"}</dd>
          </div>
          <div>
            <dt>Last latency</dt>
            <dd>{health.lastLatencyMs !== null ? `${health.lastLatencyMs}ms` : "—"}</dd>
          </div>
        </div>

        {health.lastError && (
          <p className="section-description">
            Last error: <code>{health.lastError}</code>
          </p>
        )}
      </div>

      {showEditor && formValues && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!saving) {
              setShowEditor(false);
            }
          }}
        >
          <section className="form-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Health Check</p>
                <h2>Edit Health Check</h2>
              </div>
              <button
                className="close-button"
                type="button"
                disabled={saving}
                onClick={() => setShowEditor(false)}
              >
                Close
              </button>
            </header>

            <form onSubmit={(event) => void submitEditor(event)}>
              {saveError && <div className="error-banner">{saveError}</div>}

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={formValues.enabled}
                  onChange={(event) =>
                    setFormValues((current) =>
                      current ? { ...current, enabled: event.target.checked } : current
                    )
                  }
                />
                <span>Enabled — run this check automatically on an interval</span>
              </label>

              <label>
                <span>Path</span>
                <input
                  value={formValues.path}
                  onChange={(event) =>
                    setFormValues((current) =>
                      current ? { ...current, path: event.target.value } : current
                    )
                  }
                  placeholder="/health"
                />
                <small>
                  Checked internally on this app's own container — never routed over the
                  public internet or to an external host.
                </small>
              </label>

              <label>
                <span>Expected HTTP status</span>
                <input
                  type="number"
                  min={100}
                  max={599}
                  value={formValues.expectedStatus}
                  onChange={(event) =>
                    setFormValues((current) =>
                      current
                        ? { ...current, expectedStatus: Number(event.target.value) }
                        : current
                    )
                  }
                />
              </label>

              <label>
                <span>Interval (seconds)</span>
                <input
                  type="number"
                  min={10}
                  max={3600}
                  value={formValues.intervalSeconds}
                  onChange={(event) =>
                    setFormValues((current) =>
                      current
                        ? { ...current, intervalSeconds: Number(event.target.value) }
                        : current
                    )
                  }
                />
              </label>

              <label>
                <span>Timeout (seconds)</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={formValues.timeoutSeconds}
                  onChange={(event) =>
                    setFormValues((current) =>
                      current
                        ? { ...current, timeoutSeconds: Number(event.target.value) }
                        : current
                    )
                  }
                />
                <small>Must be less than or equal to the interval.</small>
              </label>

              <label>
                <span>Failure threshold</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={formValues.failureThreshold}
                  onChange={(event) =>
                    setFormValues((current) =>
                      current
                        ? { ...current, failureThreshold: Number(event.target.value) }
                        : current
                    )
                  }
                />
                <small>Consecutive failures required before marking the app unhealthy.</small>
              </label>

              <label>
                <span>Success threshold</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={formValues.successThreshold}
                  onChange={(event) =>
                    setFormValues((current) =>
                      current
                        ? { ...current, successThreshold: Number(event.target.value) }
                        : current
                    )
                  }
                />
                <small>Consecutive successes required before marking the app healthy.</small>
              </label>

              <div className="form-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saving}
                  onClick={() => setShowEditor(false)}
                >
                  Cancel
                </button>
                <button className="primary-button" type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
