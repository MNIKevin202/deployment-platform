import { useCallback, useEffect, useState } from "react";
import type { ApiError, SpeedtestConnection, SpeedtestLatestResponse } from "../types/api";

/**
 * Connects the panel to the operator's own Speedtest Tracker so the
 * dashboard can show real internet speed. The token is write-only from
 * here: it's sent once, stored encrypted server-side, and never returned —
 * so the field is always blank on load, and saving requires re-entering it.
 */
export default function SpeedtestSettings() {
  const [connection, setConnection] = useState<SpeedtestConnection | null>(null);
  const [latest, setLatest] = useState<SpeedtestLatestResponse | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/settings/speedtest");
      const result = (await response.json().catch(() => null)) as (SpeedtestConnection & ApiError) | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Unable to load the Speedtest connection.");
      }
      setConnection(result);
      setUrl(result.url ?? "");

      if (result.configured) {
        const latestResponse = await fetch("/api/speedtest/latest");
        setLatest((await latestResponse.json().catch(() => null)) as SpeedtestLatestResponse | null);
      } else {
        setLatest(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load the Speedtest connection.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    try {
      setSaving(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/settings/speedtest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), token: token.trim() })
      });
      const result = (await response.json().catch(() => null)) as ApiError | null;
      if (!response.ok) {
        throw new Error(result?.message || "Could not connect with those details.");
      }
      // Never keep the token in component state once it's stored.
      setToken("");
      setNotice("Connected. The latest reading now shows on Overview and System.");
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not connect.");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    try {
      setSaving(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/settings/speedtest", { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Could not disconnect.");
      }
      setToken("");
      setNotice("Disconnected. The speed cards are hidden until you reconnect.");
      await load();
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : "Could not disconnect.");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    try {
      setRunning(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/speedtest/run", { method: "POST" });
      const result = (await response.json().catch(() => null)) as ApiError | null;
      if (!response.ok) {
        throw new Error(result?.message || "Could not start a speed test.");
      }
      setNotice(result?.message ?? "Speed test started.");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Could not start a speed test.");
    } finally {
      setRunning(false);
    }
  };

  const configured = connection?.configured ?? false;

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Integrations</p>
          <h2>Internet speed</h2>
        </div>
      </div>

      <p className="text-faint">
        Connect a{" "}
        <a href="https://docs.speedtest-tracker.dev" target="_blank" rel="noreferrer" className="table-link">
          Speedtest Tracker
        </a>{" "}
        instance to show your connection's latest download, upload, and ping on the Overview and System
        pages. Generate a token under <code className="inline-code">/admin/api-tokens</code> in Speedtest
        Tracker — it needs the <strong>Read Results</strong> ability, plus{" "}
        <strong>Run Speedtest</strong> if you want the button below to start one.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}
      {connection?.credentialUnreadable && (
        <div className="warning-banner">
          A connection is saved, but the platform's encryption key is unavailable, so the token can't be
          read. Re-enter it once the key is restored.
        </div>
      )}
      {configured && latest?.error && <div className="warning-banner">{latest.error}</div>}

      <div className="settings-form">
        <label>
          <span>Speedtest Tracker URL</span>
          <input
            className="wizard-input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://speedtest.apps.example.com"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label>
          <span>API token</span>
          <input
            className="wizard-input"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={configured ? "Stored — enter a new token to replace it" : "Paste the token"}
            spellCheck={false}
            autoComplete="off"
          />
          <small>
            Stored encrypted and never shown again. The connection is tested before it's saved, so a bad
            token is rejected rather than silently kept.
          </small>
        </label>

        <div className="form-actions form-actions-start">
          <button
            className="primary-button"
            type="button"
            onClick={() => void save()}
            disabled={saving || loading || url.trim() === "" || token.trim() === ""}
          >
            {saving ? "Connecting…" : configured ? "Update connection" : "Connect"}
          </button>
          {configured && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => void runNow()}
              disabled={running || saving}
            >
              {running ? "Starting…" : "Run test now"}
            </button>
          )}
          {configured && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => void disconnect()}
              disabled={saving || running}
            >
              Disconnect
            </button>
          )}
          <button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>

        {configured && latest?.reading && (
          <p className="text-faint">
            Latest: <strong>{latest.reading.downloadHuman ?? "—"}</strong> down,{" "}
            <strong>{latest.reading.uploadHuman ?? "—"}</strong> up
            {latest.reading.pingMs !== null && <> · {latest.reading.pingMs.toFixed(0)} ms ping</>}
            {latest.reading.measuredAt && <> · {new Date(latest.reading.measuredAt).toLocaleString()}</>}
          </p>
        )}
      </div>
    </section>
  );
}
