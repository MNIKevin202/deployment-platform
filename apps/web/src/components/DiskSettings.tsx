import { useCallback, useEffect, useState } from "react";
import type { ApiError, RetentionInfo, RetentionRunResult, RetentionSummary } from "../types/api";

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 MB";
  }
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function describeSummary(summary: RetentionSummary): string {
  if (summary.imagesDeleted === 0 && summary.containersRemoved === 0 && summary.versionsPruned === 0) {
    return "Nothing to reclaim — disk usage is already within your retention limits.";
  }
  const failed = summary.failures.length > 0 ? ` (${summary.failures.length} skipped)` : "";
  return (
    `Removed ${summary.imagesDeleted} image${summary.imagesDeleted === 1 ? "" : "s"} and ` +
    `${summary.containersRemoved} container${summary.containersRemoved === 1 ? "" : "s"}, pruned ` +
    `${summary.versionsPruned} old version${summary.versionsPruned === 1 ? "" : "s"}, reclaiming ` +
    `${formatBytes(summary.bytesReclaimed)} in ${(summary.durationMs / 1000).toFixed(1)}s${failed}.`
  );
}

export default function DiskSettings() {
  const [info, setInfo] = useState<RetentionInfo | null>(null);
  const [countInput, setCountInput] = useState("3");
  const [platformInput, setPlatformInput] = useState("3");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const response = await fetch("/api/settings/retention");
      const result = (await response.json().catch(() => null)) as (RetentionInfo & ApiError) | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Unable to load retention settings.");
      }
      setInfo(result);
      setCountInput(String(result.config.count));
      setPlatformInput(String(result.config.platformImageKeep));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load retention settings.");
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
      const response = await fetch("/api/settings/retention", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: Number(countInput), platformImageKeep: Number(platformInput) })
      });
      const result = (await response.json().catch(() => null)) as ApiError | null;
      if (!response.ok) {
        throw new Error(result?.message || "Unable to save.");
      }
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save.");
    } finally {
      setSaving(false);
    }
  };

  const runCleanup = async () => {
    try {
      setRunning(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/settings/retention/run", { method: "POST" });
      const result = (await response.json().catch(() => null)) as (RetentionRunResult & ApiError) | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Cleanup failed.");
      }
      setNotice(describeSummary(result.summary));
      await load();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Cleanup failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Disk &amp; images</p>
          <h2>Rollback retention</h2>
        </div>
      </div>

      <p className="text-faint">
        Every GitHub deploy keeps a revertable rollback point (its image + version). Only the most
        recent few are kept — older versions, their images, and any leftover rollback containers are
        reclaimed automatically after each deploy and once daily. The currently running version, its
        image, and all volumes are never removed.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="settings-form">
        <label>
          <span>Rollback versions to keep per app</span>
          <input
            type="number"
            className="wizard-input"
            min={1}
            max={50}
            value={countInput}
            onChange={(event) => setCountInput(event.target.value)}
          />
        </label>

        <label>
          <span>Platform images to keep (deployment-platform-api/web)</span>
          <input
            type="number"
            className="wizard-input"
            min={0}
            max={50}
            value={platformInput}
            onChange={(event) => setPlatformInput(event.target.value)}
          />
        </label>

        <div className="inline-field">
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void save()}
            disabled={saving || loading}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {info?.lastRunAt && (
          <p className="text-faint">Last full cleanup: {new Date(info.lastRunAt).toLocaleString()}.</p>
        )}

        <div className="form-actions form-actions-start">
          <button
            className="primary-button"
            type="button"
            onClick={() => void runCleanup()}
            disabled={running || loading}
          >
            {running ? "Cleaning up…" : "Clean up now"}
          </button>
          <button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>
    </section>
  );
}
