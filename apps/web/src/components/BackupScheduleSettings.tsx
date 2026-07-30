import { useCallback, useEffect, useState } from "react";
import type { ApiError, AutoBackupConfig, AutoBackupResponse } from "../types/api";

function formatDate(ms: number | null): string {
  if (!ms) {
    return "never";
  }
  return new Date(ms).toLocaleString();
}

export default function BackupScheduleSettings() {
  const [config, setConfig] = useState<AutoBackupConfig>({ enabled: false, intervalHours: 24, retention: 7 });
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [backupCount, setBackupCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/settings/auto-backup");
      const result = (await response.json().catch(() => null)) as (AutoBackupResponse & ApiError) | null;
      if (!response.ok || !result?.success || !result.config) {
        throw new Error(result?.message || "Unable to load backup settings.");
      }
      setConfig(result.config);
      setLastRunAt(result.lastRunAt);
      setBackupCount(result.backups.length);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load backup settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: AutoBackupConfig) => {
    try {
      setSaving(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/settings/auto-backup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next)
      });
      const result = (await response.json().catch(() => null)) as ApiError | null;
      if (!response.ok) {
        throw new Error(result?.message || "Unable to save.");
      }
      setConfig(next);
      setNotice("Saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save.");
      await load();
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    try {
      setRunningNow(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/settings/auto-backup/run", { method: "POST" });
      const result = (await response.json().catch(() => null)) as ApiError | null;
      if (!response.ok) {
        throw new Error(result?.message || "Backup failed.");
      }
      setNotice("Backup created.");
      await load();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Backup failed.");
    } finally {
      setRunningNow(false);
    }
  };

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Backup</p>
          <h2>Automatic backups</h2>
        </div>
      </div>

      <p className="text-faint">
        Periodically snapshot the platform database to <code>/data/backups</code> and keep the most
        recent ones. Complements the manual download below.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="settings-form">
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={loading || saving}
            onChange={(event) => void save({ ...config, enabled: event.target.checked })}
          />
          <span>Enable automatic backups</span>
        </label>

        <label>
          <span>Every (hours)</span>
          <input
            type="number"
            className="wizard-input"
            min={1}
            max={168}
            value={config.intervalHours}
            onChange={(event) => setConfig({ ...config, intervalHours: Number(event.target.value) })}
          />
        </label>

        <label>
          <span>Keep the most recent</span>
          <div className="inline-field">
            <input
              type="number"
              className="wizard-input"
              min={1}
              max={100}
              value={config.retention}
              onChange={(event) => setConfig({ ...config, retention: Number(event.target.value) })}
            />
            <button
              className="secondary-button compact"
              type="button"
              disabled={saving}
              onClick={() => void save(config)}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </label>

        <p className="text-faint">
          Last automatic backup: {formatDate(lastRunAt)} · {backupCount} kept on the server.
        </p>

        <div className="form-actions form-actions-start">
          <button className="primary-button" type="button" disabled={runningNow} onClick={() => void runNow()}>
            {runningNow ? "Backing up…" : "Back up now"}
          </button>
        </div>
      </div>
    </section>
  );
}
