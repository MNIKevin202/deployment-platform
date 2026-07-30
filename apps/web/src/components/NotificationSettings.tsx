import { useCallback, useEffect, useState } from "react";
import type { ApiError, NotificationConfig, NotificationResponse, NotificationType } from "../types/api";

export default function NotificationSettings() {
  const [config, setConfig] = useState<NotificationConfig>({ enabled: false, type: "discord", webhookUrl: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/settings/notifications");
      const result = (await response.json().catch(() => null)) as (NotificationResponse & ApiError) | null;
      if (!response.ok || !result?.success || !result.config) {
        throw new Error(result?.message || "Unable to load notification settings.");
      }
      setConfig(result.config);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load notification settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<boolean> => {
    try {
      setSaving(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/settings/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      const result = (await response.json().catch(() => null)) as ApiError | null;
      if (!response.ok) {
        throw new Error(result?.message || "Unable to save.");
      }
      setNotice("Saved.");
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    // Persist first so the server tests the current values.
    if (!(await save())) {
      return;
    }
    try {
      setTesting(true);
      setError("");
      const response = await fetch("/api/settings/notifications/test", { method: "POST" });
      const result = (await response.json().catch(() => null)) as ApiError | null;
      if (!response.ok) {
        throw new Error(result?.message || "Test failed.");
      }
      setNotice("Test notification sent — check your channel.");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Test failed.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Notifications</p>
          <h2>Deploy notifications</h2>
        </div>
      </div>

      <p className="text-faint">
        Get a message in Discord, Slack, or any webhook when a deploy succeeds, fails, or rolls back —
        useful now that auto-deploy runs on its own.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="settings-form">
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={loading}
            onChange={(event) => setConfig({ ...config, enabled: event.target.checked })}
          />
          <span>Enable deploy notifications</span>
        </label>

        <label>
          <span>Webhook type</span>
          <select
            className="wizard-select"
            value={config.type}
            onChange={(event) => setConfig({ ...config, type: event.target.value as NotificationType })}
          >
            <option value="discord">Discord</option>
            <option value="slack">Slack</option>
            <option value="generic">Generic (JSON)</option>
          </select>
        </label>

        <label>
          <span>Webhook URL</span>
          <input
            type="url"
            className="wizard-input"
            placeholder="https://discord.com/api/webhooks/…"
            value={config.webhookUrl}
            onChange={(event) => setConfig({ ...config, webhookUrl: event.target.value })}
          />
        </label>

        <div className="form-actions form-actions-start">
          <button className="primary-button" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={testing || saving || !config.webhookUrl}
            onClick={() => void sendTest()}
          >
            {testing ? "Sending…" : "Send test"}
          </button>
        </div>
      </div>
    </section>
  );
}
