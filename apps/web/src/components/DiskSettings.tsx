import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, RetentionInfo, RetentionRunResult, RetentionSummary } from "../types/api";
import StatCard from "./StatCard";

/** How often the live Docker usage card quietly refreshes itself in the background. */
const USAGE_POLL_INTERVAL_MS = 20_000;

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

function formatBytesGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatRelativeTime(ms: number): string {
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSeconds < 60) {
    return "just now";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
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
  // Tracks whether a fetch is the very first one (shows the loading state) or
  // a quiet background poll (must not flash "Checking..." over live numbers).
  const hasLoadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      if (!hasLoadedOnce.current) {
        setLoading(true);
      }
      setError("");
      const response = await fetch("/api/settings/retention");
      const result = (await response.json().catch(() => null)) as (RetentionInfo & ApiError) | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Unable to load retention settings.");
      }
      setInfo(result);
      // Only seed the editable inputs on the very first load — a background
      // poll must never clobber text the operator is mid-edit on.
      if (!hasLoadedOnce.current) {
        setCountInput(String(result.config.count));
        setPlatformInput(String(result.config.platformImageKeep));
      }
      hasLoadedOnce.current = true;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load retention settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), USAGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
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

  const usage = info?.usage ?? null;
  const lastCleanup = info?.lastCleanup ?? null;
  const lifetime = info?.lifetimeStats ?? null;
  const averageBytes =
    lifetime && lifetime.totalRuns > 0 ? lifetime.totalBytesReclaimed / lifetime.totalRuns : 0;

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

      <h3>Current Docker usage</h3>
      {info?.usageError ? (
        <p className="text-faint">Unable to read live Docker usage: {info.usageError}</p>
      ) : (
        <section className="stats-grid">
          <StatCard label="Images" value={usage ? String(usage.images) : "—"} />
          <StatCard label="Containers" value={usage ? String(usage.containers) : "—"} />
          <StatCard label="Volumes" value={usage ? String(usage.volumes) : "—"} />
          <StatCard
            label="Docker images size"
            value={usage ? formatBytesGb(usage.imagesSizeBytes) : "—"}
          />
          <StatCard
            label="Disk used"
            value={usage ? `${formatBytesGb(usage.usedBytes)} / ${formatBytesGb(usage.totalBytes)}` : "—"}
          />
          <StatCard
            label="Last cleanup"
            value={lastCleanup ? formatRelativeTime(lastCleanup.at) : "Never"}
            hint={lastCleanup ? `Reclaimed ${formatBytes(lastCleanup.bytesReclaimed)}` : undefined}
          />
        </section>
      )}

      <h3>Cleanup statistics</h3>
      <section className="stats-grid">
        <StatCard label="Images removed" value={lifetime ? lifetime.totalImagesDeleted.toLocaleString() : "—"} />
        <StatCard
          label="Containers removed"
          value={lifetime ? lifetime.totalContainersRemoved.toLocaleString() : "—"}
        />
        <StatCard label="Space reclaimed" value={lifetime ? formatBytes(lifetime.totalBytesReclaimed) : "—"} />
        <StatCard label="Average cleanup" value={lifetime ? formatBytes(averageBytes) : "—"} />
      </section>

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

        <div className="form-actions form-actions-start">
          <button
            className="primary-button"
            type="button"
            onClick={() => void runCleanup()}
            disabled={running || loading}
          >
            {running ? "Running cleanup…" : "Run Cleanup Now"}
          </button>
          <button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>
    </section>
  );
}
