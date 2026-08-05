import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, RetentionInfo, RetentionLastCleanup, RetentionRunResult, RetentionSummary } from "../types/api";
import StatCard from "./StatCard";

/**
 * How often the live Docker usage card quietly refreshes itself in the
 * background. Kept well above the server's own Docker-usage timeout (5s,
 * see docker-usage-service.ts) and its cache TTL (30s) — polling faster than
 * the cache is fresh would only add load for no fresher data.
 */
const USAGE_POLL_INTERVAL_MS = 60_000;
/**
 * A hard client-side cutoff for the settings fetch itself, independent of
 * whatever the server-side Docker lookup does. `docker system df` can be
 * slow enough on a host with many images that, without a limit here, a
 * single hung request would leave the page's loading state stuck forever —
 * exactly what happened before this was added. Longer than the server's own
 * 5s Docker-usage budget to leave room for a normal round trip.
 */
const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

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

function formatDiskUsage(usedBytes: number, totalBytes: number): string {
  const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
  return `${formatBytesGb(usedBytes)} / ${formatBytesGb(totalBytes)} (${percent}%)`;
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

function formatAbsoluteTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * "Docker data reclaimed" rather than "space reclaimed" — Docker shares image
 * layers across builds, so removing one image doesn't always free that
 * image's own full size on disk. This number is what Docker itself freed for
 * those specific images; actual host disk space may improve by less, since a
 * shared base layer only truly leaves disk once every image referencing it
 * is gone (never claim more than what actually happened).
 */
function describeSummary(summary: RetentionSummary): string {
  if (summary.imagesDeleted === 0 && summary.containersRemoved === 0 && summary.versionsPruned === 0) {
    return "Nothing to reclaim — disk usage is already within your retention limits.";
  }
  const failed = summary.failures.length > 0 ? ` (${summary.failures.length} skipped)` : "";
  return (
    `Removed ${summary.imagesDeleted} image${summary.imagesDeleted === 1 ? "" : "s"} and ` +
    `${summary.containersRemoved} container${summary.containersRemoved === 1 ? "" : "s"}, pruned ` +
    `${summary.versionsPruned} old version${summary.versionsPruned === 1 ? "" : "s"} — ` +
    `${formatBytes(summary.bytesReclaimed)} of Docker data reclaimed in ${formatDuration(summary.durationMs)}${failed}.`
  );
}

const HISTORY_ANCHOR_ID = "cleanup-history";

export default function DiskSettings() {
  const [info, setInfo] = useState<RetentionInfo | null>(null);
  const [countInput, setCountInput] = useState("3");
  const [platformInput, setPlatformInput] = useState("3");
  const [loading, setLoading] = useState(true);
  // True for the whole duration of any load() call (first load, poll, or
  // post-cleanup refresh) — used only to soften the usage card's error
  // state, distinct from `loading`, which is exclusively the very-first load.
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ message: string; at: number } | null>(null);
  const [dismissedNoticeAt, setDismissedNoticeAt] = useState<number | null>(null);
  // Tracks whether a fetch is the very first one (shows the loading state) or
  // a quiet background poll (must not flash "Checking..." over live numbers).
  const hasLoadedOnce = useRef(false);
  // Prevents a poll tick from starting a second overlapping request while a
  // previous one (manual refresh, a slow Docker lookup) is still in flight.
  const isFetching = useRef(false);

  const load = useCallback(async () => {
    if (isFetching.current) {
      return;
    }
    isFetching.current = true;
    setRefreshing(true);

    try {
      if (!hasLoadedOnce.current) {
        setLoading(true);
      }
      setError("");
      const response = await fetchWithTimeout("/api/settings/retention");
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
      const message =
        loadError instanceof Error && loadError.name === "AbortError"
          ? "Loading retention settings timed out. Docker may be slow to respond right now — try Refresh."
          : loadError instanceof Error
            ? loadError.message
            : "Unable to load retention settings.";
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
      isFetching.current = false;
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
      const response = await fetch("/api/settings/retention/run", { method: "POST" });
      const result = (await response.json().catch(() => null)) as (RetentionRunResult & ApiError) | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Cleanup failed.");
      }
      const at = Date.now();
      setNotice({ message: describeSummary(result.summary), at });
      setDismissedNoticeAt(null);
      // The server invalidates its Docker-usage cache as part of a
      // successful cleanup, so this reload gets fresh post-cleanup counts
      // immediately rather than whatever was cached before the cleanup ran.
      await load();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Cleanup failed.");
    } finally {
      setRunning(false);
    }
  };

  const scrollToHistory = () => {
    document.getElementById(HISTORY_ANCHOR_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const usage = info?.usage ?? null;
  const lastCleanup = info?.lastCleanup ?? null;
  const lifetime = info?.lifetimeStats ?? null;
  const history = info?.history ?? [];
  const averageBytes =
    lifetime && lifetime.totalRuns > 0 ? lifetime.totalBytesReclaimed / lifetime.totalRuns : 0;
  // Suppress a stale usage error while something that will resolve it is
  // already in flight (a cleanup, or any refresh) — showing "Unable to read
  // Docker usage" during a normal poll or an active cleanup reads as a false
  // alarm rather than the transient state it actually is.
  const showUsageError = Boolean(info?.usageError) && !running && !refreshing;

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
      {notice && notice.at !== dismissedNoticeAt && (
        <div className="notice-banner notice-banner-row">
          <span>
            <strong>{formatAbsoluteTime(notice.at)}</strong> — {notice.message}{" "}
            {history.length > 0 && (
              <button type="button" className="notice-banner-link" onClick={scrollToHistory}>
                View details
              </button>
            )}
          </span>
          <button
            type="button"
            className="notice-banner-dismiss"
            aria-label="Dismiss"
            onClick={() => setDismissedNoticeAt(notice.at)}
          >
            ✕
          </button>
        </div>
      )}

      <h3>
        Current Docker usage
        {(running || (refreshing && hasLoadedOnce.current)) && (
          <span className="text-faint" style={{ fontWeight: 400, fontSize: "0.8rem", marginLeft: 8 }}>
            <span className="inline-spinner" aria-hidden="true" />
            {running ? "Cleaning up…" : "Refreshing…"}
          </span>
        )}
      </h3>
      {showUsageError ? (
        <p className="text-faint">Unable to read live Docker usage: {info?.usageError}</p>
      ) : (
        <section className="stats-grid">
          <StatCard
            label="Disk used"
            value={usage ? formatDiskUsage(usage.usedBytes, usage.totalBytes) : "—"}
          />
          <StatCard label="Docker images" value={usage ? String(usage.images) : "—"} />
          <StatCard label="Running containers" value={usage ? String(usage.runningContainers) : "—"} />
          <StatCard label="Total containers" value={usage ? String(usage.containers) : "—"} />
          <StatCard label="Volumes" value={usage ? String(usage.volumes) : "—"} />
          <StatCard
            label="Docker image size"
            value={usage ? formatBytesGb(usage.imagesSizeBytes) : "—"}
          />
          <StatCard
            label="Last cleanup"
            value={lastCleanup ? formatRelativeTime(lastCleanup.at) : "Never"}
            hint={lastCleanup ? formatAbsoluteTime(lastCleanup.at) : undefined}
          />
        </section>
      )}

      <h3>Lifetime Cleanup Statistics</h3>
      <section className="stats-grid">
        <StatCard label="Images removed" value={lifetime ? lifetime.totalImagesDeleted.toLocaleString() : "—"} />
        <StatCard
          label="Containers removed"
          value={lifetime ? lifetime.totalContainersRemoved.toLocaleString() : "—"}
        />
        <StatCard label="Docker data reclaimed" value={lifetime ? formatBytes(lifetime.totalBytesReclaimed) : "—"} />
        <StatCard label="Average cleanup size" value={lifetime ? formatBytes(averageBytes) : "—"} />
        <StatCard label="Largest cleanup" value={lifetime ? formatBytes(lifetime.largestCleanupBytes) : "—"} />
        <StatCard label="Total cleanup runs" value={lifetime ? lifetime.totalRuns.toLocaleString() : "—"} />
      </section>

      <div id={HISTORY_ANCHOR_ID} className="env-scope-heading">
        <h3>Cleanup history</h3>
      </div>
      {history.length === 0 ? (
        <div className="empty-state">No cleanups recorded yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="env-table history-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Images Removed</th>
                <th>Containers Removed</th>
                <th>Docker Data Reclaimed</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry: RetentionLastCleanup) => (
                <tr key={entry.at}>
                  <td className="text-faint">{formatAbsoluteTime(entry.at)}</td>
                  <td>{entry.imagesDeleted.toLocaleString()}</td>
                  <td>{entry.containersRemoved.toLocaleString()}</td>
                  <td>{formatBytes(entry.bytesReclaimed)}</td>
                  <td className="text-faint">{formatDuration(entry.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
            {running && <span className="inline-spinner" aria-hidden="true" />}
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
