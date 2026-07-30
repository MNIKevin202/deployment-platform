import { useCallback, useEffect, useState } from "react";
import type { ApiError, ImagePruneInfo, ImagePruneResult } from "../types/api";

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

export default function DiskSettings() {
  const [info, setInfo] = useState<ImagePruneInfo | null>(null);
  const [keepInput, setKeepInput] = useState("5");
  const [loading, setLoading] = useState(true);
  const [savingKeep, setSavingKeep] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const response = await fetch("/api/images/prune");
      const result = (await response.json().catch(() => null)) as (ImagePruneInfo & ApiError) | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Unable to load image info.");
      }
      setInfo(result);
      setKeepInput(String(result.keepPerApp));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load image info.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveKeep = async () => {
    try {
      setSavingKeep(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/images/prune", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepPerApp: Number(keepInput) })
      });
      const result = (await response.json().catch(() => null)) as ApiError | null;
      if (!response.ok) {
        throw new Error(result?.message || "Unable to save.");
      }
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save.");
    } finally {
      setSavingKeep(false);
    }
  };

  const runPrune = async () => {
    try {
      setPruning(true);
      setError("");
      setNotice("");
      const response = await fetch("/api/images/prune/run", { method: "POST" });
      const result = (await response.json().catch(() => null)) as (ImagePruneResult & ApiError) | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Prune failed.");
      }
      setNotice(
        `Removed ${result.removed} image${result.removed === 1 ? "" : "s"}, reclaiming ${formatBytes(
          result.reclaimedBytes
        )}${result.failed > 0 ? ` (${result.failed} skipped)` : ""}.`
      );
      await load();
    } catch (pruneError) {
      setError(pruneError instanceof Error ? pruneError.message : "Prune failed.");
    } finally {
      setPruning(false);
    }
  };

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Disk &amp; images</p>
          <h2>Clean up build images</h2>
        </div>
      </div>

      <p className="text-faint">
        Every GitHub deploy builds a new image; old ones pile up and use disk. This removes dangling
        images and, per app, keeps only the most recent builds (the rest are still available to revert
        to until pruned).
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="settings-form">
        <label>
          <span>Recent builds to keep per app</span>
          <div className="inline-field">
            <input
              type="number"
              className="wizard-input"
              min={0}
              max={50}
              value={keepInput}
              onChange={(event) => setKeepInput(event.target.value)}
            />
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => void saveKeep()}
              disabled={savingKeep}
            >
              {savingKeep ? "Saving…" : "Save"}
            </button>
          </div>
        </label>

        <p className="text-faint">
          {loading
            ? "Checking reclaimable space…"
            : info
              ? `${info.candidates} image${info.candidates === 1 ? "" : "s"} can be removed, reclaiming about ${formatBytes(
                  info.reclaimableBytes
                )}.`
              : ""}
        </p>

        <div className="form-actions form-actions-start">
          <button
            className="primary-button"
            type="button"
            onClick={() => void runPrune()}
            disabled={pruning || loading || (info?.candidates ?? 0) === 0}
          >
            {pruning ? "Pruning…" : "Prune now"}
          </button>
          <button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>
    </section>
  );
}
