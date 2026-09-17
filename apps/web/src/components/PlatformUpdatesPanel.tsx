import { useCallback, useEffect, useState } from "react";
import UpdateConfirmModal from "./UpdateConfirmModal";

/**
 * The platform self-update control surface — talks to /api/platform/updates/*.
 * This is ClovaForge updating ITSELF (see docs/SELF_UPDATE_ARCHITECTURE.md),
 * distinct from the browser-tab version check below it in the Updates tab.
 *
 * It never fabricates progress percentages (the host updater reports discrete
 * states, not a byte count) and only shows "Update Now" for a verified,
 * directly-installable update. All actions inherit the platform's session
 * auth — an unauthenticated caller never reaches these endpoints.
 */

type UpdateState =
  | "idle"
  | "checking"
  | "update_available"
  | "downloading"
  | "verifying"
  | "preparing"
  | "installing"
  | "migrating"
  | "health_checking"
  | "successful"
  | "rolling_back"
  | "rolled_back"
  | "failed"
  | "manual_intervention_required";

type Channel = "stable" | "beta" | "nightly";
type Policy = "notify_only" | "automatic_patch" | "automatic";

interface MaintenanceWindow {
  start: string;
  end: string;
  timezone: string;
}

interface UpdateSettings {
  channel: Channel;
  policy: Policy;
  manifestBaseUrl: string;
  maintenanceWindow: MaintenanceWindow | null;
}

interface CheckResult {
  outcome: "up-to-date" | "update-available" | "check-failed";
  latestVersion?: string;
  requiresIncrementalUpgrade?: boolean;
  requiresManualApproval?: boolean;
  rollbackSafe?: boolean;
  autoApplyEligible?: boolean;
  autoApplyReason?: string;
  reason?: string;
  detail?: string;
}

interface StatusResponse {
  currentVersion: string;
  status: { lastCheckedAt: string; result: CheckResult } | null;
  state: { state: UpdateState; targetVersion: string | null; detail: string | null; updatedAt: string };
  latestSuccessfulUpdate: { toVersion: string; finishedAt: string | null } | null;
}

interface HistoryEntry {
  id: number;
  fromVersion: string | null;
  toVersion: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  result: string;
  healthResult: string | null;
  rollbackAttempted: boolean;
  diagnostic: string | null;
}

const STATE_LABELS: Record<UpdateState, string> = {
  idle: "Up to date",
  checking: "Checking…",
  update_available: "Update available",
  downloading: "Downloading…",
  verifying: "Verifying…",
  preparing: "Preparing…",
  installing: "Installing…",
  migrating: "Migrating database…",
  health_checking: "Health checking…",
  successful: "Updated successfully",
  rolling_back: "Rolling back…",
  rolled_back: "Rolled back",
  failed: "Failed",
  manual_intervention_required: "Manual intervention required"
};

function stateTone(state: UpdateState): string {
  if (state === "successful" || state === "idle") return "positive";
  if (state === "update_available") return "warning";
  if (state === "failed" || state === "manual_intervention_required") return "danger";
  if (state === "rolled_back") return "warning";
  return "info";
}

function resultTone(result: string): string {
  if (result === "successful") return "positive";
  if (result === "rolled_back") return "warning";
  if (result === "in_progress") return "info";
  return "danger";
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

const browserTimezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export default function PlatformUpdatesPanel() {
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [windowEnabled, setWindowEnabled] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      const [settingsRes, statusRes, historyRes] = await Promise.all([
        fetch("/api/platform/updates/settings"),
        fetch("/api/platform/updates/status"),
        fetch("/api/platform/updates/history")
      ]);
      if (!settingsRes.ok || !statusRes.ok || !historyRes.ok) {
        throw new Error("Unable to load update information.");
      }
      const settingsBody = await settingsRes.json();
      const statusBody = (await statusRes.json()) as StatusResponse & { success: boolean };
      const historyBody = await historyRes.json();
      setSettings(settingsBody.settings);
      setWindowEnabled(settingsBody.settings.maintenanceWindow !== null);
      setStatus(statusBody);
      setHistory(historyBody.history ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load update information.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const check = async () => {
    try {
      setChecking(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/platform/updates/check", { method: "POST" });
      if (!response.ok) throw new Error("Update check failed.");
      await load();
      setNotice("Checked for updates.");
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "Update check failed.");
    } finally {
      setChecking(false);
    }
  };

  const saveSettings = async (next: UpdateSettings) => {
    try {
      setSaving(true);
      setError("");
      const response = await fetch("/api/platform/updates/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next)
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || "Could not save update settings.");
      }
      setSettings(next);
      setNotice("Update settings saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save update settings.");
    } finally {
      setSaving(false);
    }
  };

  // Immediate apply through the narrow host bridge (POST /apply), so the update
  // starts now rather than waiting for the 15-minute timer. The host updater
  // remains the sole authority; this only records the request and pokes it.
  const updateNow = async () => {
    try {
      setApplying(true);
      setError("");
      const response = await fetch("/api/platform/updates/apply", { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message || "Could not start the update.");
      setNotice(body?.message || "Update started.");
      setConfirmOpen(false);
      await load();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Could not start the update.");
    } finally {
      setApplying(false);
    }
  };

  if (loading) {
    return <div className="empty-state">Loading update status…</div>;
  }
  if (!settings || !status) {
    return <div className="error-banner">{error || "Update information is unavailable."}</div>;
  }

  const state = status.state.state;
  const result = status.status?.result;
  const updateAvailable = result?.outcome === "update-available";
  const canUpdateNow = updateAvailable && !result?.requiresIncrementalUpgrade;
  const inFlight = ["downloading", "verifying", "preparing", "installing", "migrating", "health_checking", "rolling_back"].includes(
    state
  );

  const patchSettings = (patch: Partial<UpdateSettings>) => {
    void saveSettings({ ...settings, ...patch });
  };

  return (
    <>
      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Platform updates</p>
            <h2>ClovaForge {status.currentVersion}</h2>
          </div>
          <div className="section-heading-actions">
            <span className={`status-badge ${stateTone(state)}`}>{STATE_LABELS[state]}</span>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="notice-banner">{notice}</div>}

        <div className="settings-form">
          <p className="update-version">
            Current version <code className="inline-code">{status.currentVersion}</code>
          </p>
          {result?.outcome === "update-available" && (
            <p className="text-faint">
              Latest available <code className="inline-code">{result.latestVersion}</code>
              {result.requiresIncrementalUpgrade && (
                <strong> — this installation is too old to jump straight here; an incremental upgrade is required.</strong>
              )}
              {result.requiresManualApproval && !result.requiresIncrementalUpgrade && (
                <strong> — this release requires manual approval.</strong>
              )}
            </p>
          )}
          {result?.outcome === "up-to-date" && <p className="text-faint">This is the latest release for the {settings.channel} channel.</p>}
          {result?.outcome === "check-failed" && (
            <p className="text-faint">Last check could not complete: {result.reason} ({result.detail}).</p>
          )}
          {result && typeof result.rollbackSafe === "boolean" && updateAvailable && (
            <p className="text-faint">
              Automatic rollback if this update fails:{" "}
              {result.rollbackSafe ? "available (safe container revert)" : "not automatic (a breaking migration would need a database restore)"}.
            </p>
          )}
          <p className="text-faint">Last checked {formatTime(status.status?.lastCheckedAt)}.</p>
          <p className="text-faint">
            Last successful update:{" "}
            {status.latestSuccessfulUpdate
              ? `${status.latestSuccessfulUpdate.toVersion} on ${formatTime(status.latestSuccessfulUpdate.finishedAt)}`
              : "none yet"}
            .
          </p>
          {status.state.detail && <p className="text-faint">Status detail: {status.state.detail}</p>}

          <div className="form-actions form-actions-start">
            <button className="secondary-button" type="button" onClick={() => void check()} disabled={checking || inFlight}>
              {checking ? "Checking…" : "Check for updates"}
            </button>
            {canUpdateNow && (
              <button
                className="primary-button"
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={applying || inFlight}
              >
                {applying ? "Starting…" : `Update now to ${result?.latestVersion}`}
              </button>
            )}
          </div>

          <UpdateConfirmModal
            open={confirmOpen}
            currentVersion={status.currentVersion}
            newVersion={result?.latestVersion ?? ""}
            signedVerified={result?.outcome === "update-available"}
            compatible={!result?.requiresIncrementalUpgrade}
            rollbackSafe={result?.rollbackSafe !== false}
            confirming={applying}
            error={error || null}
            onConfirm={() => void updateNow()}
            onCancel={() => setConfirmOpen(false)}
          />
          {inFlight && (
            <p className="text-faint">
              An update is in progress ({STATE_LABELS[state]}). This page reflects the host updater's state; it does not need to stay open.
            </p>
          )}
          {state === "manual_intervention_required" && (
            <div className="error-banner">
              This installation needs manual intervention — an update could not complete or be safely rolled back. See the update log on
              the server and docs/SELF_UPDATE_ARCHITECTURE.md "Emergency manual recovery".
            </div>
          )}
        </div>
      </section>

      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Configuration</p>
            <h2>Channel &amp; policy</h2>
          </div>
        </div>

        <div className="settings-form">
          <label className="field-label" htmlFor="update-channel">
            Release channel
          </label>
          <select
            id="update-channel"
            className="wizard-select"
            value={settings.channel}
            disabled={saving}
            onChange={(event) => patchSettings({ channel: event.target.value as Channel })}
          >
            <option value="stable">Stable (recommended)</option>
            <option value="beta">Beta (earlier releases)</option>
          </select>

          <label className="field-label" htmlFor="update-policy">
            Update policy
          </label>
          <select
            id="update-policy"
            className="wizard-select"
            value={settings.policy}
            disabled={saving}
            onChange={(event) => patchSettings({ policy: event.target.value as Policy })}
          >
            <option value="notify_only">Notify only — never install automatically</option>
            <option value="automatic_patch">Automatic patch &amp; security updates only</option>
            <option value="automatic">Automatic (patch and minor; major always manual)</option>
          </select>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={windowEnabled}
              disabled={saving}
              onChange={(event) => {
                const enabled = event.target.checked;
                setWindowEnabled(enabled);
                patchSettings({
                  maintenanceWindow: enabled ? settings.maintenanceWindow ?? { start: "02:00", end: "05:00", timezone: browserTimezone } : null
                });
              }}
            />
            Only install automatic updates during a maintenance window
          </label>

          {windowEnabled && settings.maintenanceWindow && (
            <div className="form-actions form-actions-start">
              <input
                type="time"
                aria-label="Maintenance window start"
                className="wizard-select"
                value={settings.maintenanceWindow.start}
                disabled={saving}
                onChange={(event) =>
                  patchSettings({ maintenanceWindow: { ...settings.maintenanceWindow!, start: event.target.value } })
                }
              />
              <input
                type="time"
                aria-label="Maintenance window end"
                className="wizard-select"
                value={settings.maintenanceWindow.end}
                disabled={saving}
                onChange={(event) =>
                  patchSettings({ maintenanceWindow: { ...settings.maintenanceWindow!, end: event.target.value } })
                }
              />
              <input
                type="text"
                aria-label="Maintenance window timezone"
                className="wizard-select"
                value={settings.maintenanceWindow.timezone}
                disabled={saving}
                onChange={(event) =>
                  patchSettings({ maintenanceWindow: { ...settings.maintenanceWindow!, timezone: event.target.value } })
                }
              />
            </div>
          )}
          <p className="text-faint">
            A manual "Update now" always runs immediately, regardless of the maintenance window. Major version upgrades are never
            installed automatically.
          </p>
        </div>
      </section>

      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">History</p>
            <h2>Update history</h2>
          </div>
        </div>

        {history.length === 0 ? (
          <div className="empty-state">No platform updates have run yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="env-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Result</th>
                  <th>When</th>
                  <th>Trigger</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td className="env-key-cell">
                      <code>
                        {entry.fromVersion ? `${entry.fromVersion} → ` : ""}
                        {entry.toVersion}
                      </code>
                    </td>
                    <td>
                      <span className={`status-badge compact ${resultTone(entry.result)}`}>{entry.result.replace(/_/g, " ")}</span>
                      {entry.rollbackAttempted && <span className="text-faint"> (rollback attempted)</span>}
                    </td>
                    <td className="text-faint">{formatTime(entry.finishedAt ?? entry.startedAt)}</td>
                    <td className="text-faint">{entry.trigger}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
