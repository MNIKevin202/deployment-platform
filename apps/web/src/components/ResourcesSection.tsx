import { useState } from "react";
import type { ApiError } from "../types/api";

interface ResourcesSectionProps {
  appId: number;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  containerRunning: boolean;
  onSaved: () => void;
}

export default function ResourcesSection({
  appId,
  memoryLimitMb,
  cpuLimit,
  containerRunning,
  onSaved
}: ResourcesSectionProps) {
  const [memory, setMemory] = useState(memoryLimitMb ? String(memoryLimitMb) : "");
  const [cpu, setCpu] = useState(cpuLimit ? String(cpuLimit) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const save = async () => {
    try {
      setSaving(true);
      setError("");
      setNotice("");

      const response = await fetch(`/api/apps/${appId}/resources`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memoryLimitMb: memory.trim() ? Number(memory) : null,
          cpuLimit: cpu.trim() ? Number(cpu) : null
        })
      });
      const result = (await response.json().catch(() => null)) as ApiError | null;
      if (!response.ok) {
        throw new Error(result?.message || "Unable to update resource limits.");
      }
      setNotice("Resource limits applied — the container was recreated.");
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to update resource limits.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app-detail-resources">
      <div className="env-scope-heading">
        <h3>Resource limits</h3>
      </div>

      <p className="text-faint">
        Optional caps on how much memory and CPU this app's container may use. Saving recreates the
        container to apply them{containerRunning ? " (a brief restart)" : ""}. Leave a field blank for
        no limit.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="settings-form">
        <label>
          <span>Memory limit (MB)</span>
          <input
            type="number"
            value={memory}
            min={16}
            max={131072}
            placeholder="No limit"
            onChange={(event) => setMemory(event.target.value)}
          />
        </label>
        <label>
          <span>CPU limit (cores)</span>
          <input
            type="number"
            value={cpu}
            min={0.1}
            max={64}
            step={0.1}
            placeholder="No limit"
            onChange={(event) => setCpu(event.target.value)}
          />
        </label>

        <div className="form-actions form-actions-start">
          <button className="primary-button compact" type="button" onClick={() => void save()} disabled={saving}>
            {saving ? "Applying…" : "Save & apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
