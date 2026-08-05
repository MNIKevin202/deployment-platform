import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApiError,
  CronJob,
  CronJobRun,
  CronJobRunsResponse,
  CronJobsResponse,
  CronPreviewResponse,
  StoredApp
} from "../types/api";
import ConfirmationDialog from "../components/ConfirmationDialog";
import CopyButton from "../components/CopyButton";
import StatCard from "../components/StatCard";

interface CronPageProps {
  /** Apps the operator can target — the command runs in the app's container. */
  apps: StoredApp[];
}

interface JobFormState {
  id: number | null;
  appId: number | null;
  name: string;
  cronExpression: string;
  command: string;
  enabled: boolean;
  timeoutSeconds: string;
}

const EMPTY_FORM: JobFormState = {
  id: null,
  appId: null,
  name: "",
  cronExpression: "0 3 * * *",
  command: "",
  enabled: true,
  timeoutSeconds: "300"
};

const COMMON_SCHEDULES: Array<{ expr: string; label: string }> = [
  { expr: "*/15 * * * *", label: "Every 15 min" },
  { expr: "0 * * * *", label: "Hourly" },
  { expr: "0 3 * * *", label: "Daily 3 AM" },
  { expr: "0 0 * * 0", label: "Weekly (Sun)" },
  { expr: "0 0 1 * *", label: "Monthly (1st)" }
];

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function statusTone(status: CronJob["lastStatus"] | CronJobRun["status"]): string {
  switch (status) {
    case "success":
      return "positive";
    case "failed":
    case "timeout":
      return "danger";
    case "skipped":
      return "warning";
    default:
      return "neutral";
  }
}

/**
 * A glyph hinting at what a job does, inferred from its name — purely
 * decorative (the name beside it is always the real identifier), so an
 * unrecognized job just gets a neutral clock.
 */
function jobIcon(name: string): string {
  const text = name.toLowerCase();
  if (/mail|email|smtp|inbox|ingest/.test(text)) return "✉️";
  if (/track|report|stat|metric|analytic/.test(text)) return "📈";
  if (/package|ship|deliver|order/.test(text)) return "📦";
  if (/backup|snapshot|dump/.test(text)) return "💾";
  if (/clean|prune|purge|vacuum|sweep/.test(text)) return "🧹";
  if (/sync|import|export|fetch/.test(text)) return "🔄";
  return "⏰";
}

/** A compact "2m 14s ago"-style string for a past timestamp. */
function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function CronPage({ apps }: CronPageProps) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [form, setForm] = useState<JobFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [preview, setPreview] = useState<{ valid: boolean; text: string }>({
    valid: true,
    text: ""
  });

  const [deleteTarget, setDeleteTarget] = useState<CronJob | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);
  /** Which job's command is expanded past its 3-line clamp, if any. */
  const [expandedCommandId, setExpandedCommandId] = useState<number | null>(null);

  // Run-history modal: the job whose history is open, its loaded runs, and
  // which run's output is currently shown.
  const [historyJob, setHistoryJob] = useState<CronJob | null>(null);
  const [runs, setRuns] = useState<CronJobRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState("");
  const [selectedRun, setSelectedRun] = useState<CronJobRun | null>(null);

  const previewTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/cron-jobs");
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load cron jobs"));
      }
      const result = (await response.json()) as CronJobsResponse;
      setJobs(result.jobs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load cron jobs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced live preview of the cron expression, from the API's own
  // parser — so the plain-English description can never disagree with what
  // the scheduler will actually do.
  useEffect(() => {
    if (!form) {
      return;
    }
    if (previewTimer.current) {
      window.clearTimeout(previewTimer.current);
    }
    const expression = form.cronExpression;
    previewTimer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/cron-jobs/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cronExpression: expression })
          });
          const result = (await response.json()) as CronPreviewResponse;
          if (result.valid) {
            setPreview({ valid: true, text: result.description ?? "" });
          } else {
            setPreview({ valid: false, text: result.error ?? "Invalid expression" });
          }
        } catch {
          setPreview({ valid: false, text: "Could not validate the expression." });
        }
      })();
    }, 250);

    return () => {
      if (previewTimer.current) {
        window.clearTimeout(previewTimer.current);
      }
    };
  }, [form?.cronExpression, form]);

  const openCreate = () => {
    setFormError("");
    setPreview({ valid: true, text: "" });
    setForm({ ...EMPTY_FORM, appId: apps[0]?.id ?? null });
  };

  const openEdit = (job: CronJob) => {
    setFormError("");
    setPreview({ valid: true, text: "" });
    setForm({
      id: job.id,
      appId: job.appId,
      name: job.name,
      cronExpression: job.cronExpression,
      command: job.command,
      enabled: job.enabled,
      timeoutSeconds: String(job.timeoutSeconds)
    });
  };

  const saveForm = async () => {
    if (!form) return;

    if (form.appId === null) {
      setFormError("Choose an app to run the command in.");
      return;
    }

    setSaving(true);
    setFormError("");

    const payload = {
      appId: form.appId,
      name: form.name.trim(),
      cronExpression: form.cronExpression.trim(),
      command: form.command,
      enabled: form.enabled,
      timeoutSeconds: Number(form.timeoutSeconds) || 300
    };

    try {
      const response =
        form.id === null
          ? await fetch("/api/cron-jobs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            })
          : await fetch(`/api/cron-jobs/${form.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: payload.name,
                cronExpression: payload.cronExpression,
                command: payload.command,
                enabled: payload.enabled,
                timeoutSeconds: payload.timeoutSeconds
              })
            });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to save the cron job"));
      }

      setNotice(form.id === null ? "Cron job created." : "Cron job saved.");
      setForm(null);
      await load();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Unable to save the cron job");
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (job: CronJob) => {
    try {
      const response = await fetch(`/api/cron-jobs/${job.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: job.name,
          cronExpression: job.cronExpression,
          command: job.command,
          enabled: !job.enabled,
          timeoutSeconds: job.timeoutSeconds
        })
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to update the cron job"));
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update the cron job");
    }
  };

  const runNow = async (job: CronJob) => {
    setRunningId(job.id);
    setError("");
    try {
      const response = await fetch(`/api/cron-jobs/${job.id}/run`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to run the cron job"));
      }
      setNotice(`Ran "${job.name}".`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to run the cron job");
    } finally {
      setRunningId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      const response = await fetch(`/api/cron-jobs/${deleteTarget.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to delete the cron job"));
      }
      setNotice("Cron job deleted.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete the cron job");
    } finally {
      setDeleteTarget(null);
    }
  };

  const openHistory = async (job: CronJob) => {
    setHistoryJob(job);
    setRuns([]);
    setSelectedRun(null);
    setRunsError("");
    setRunsLoading(true);
    try {
      const response = await fetch(`/api/cron-jobs/${job.id}/runs`);
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load run history"));
      }
      const result = (await response.json()) as CronJobRunsResponse;
      setRuns(result.runs);
      // Show the newest run's output by default — the endpoint returns
      // newest first.
      setSelectedRun(result.runs[0] ?? null);
    } catch (caught) {
      setRunsError(caught instanceof Error ? caught.message : "Unable to load run history");
    } finally {
      setRunsLoading(false);
    }
  };

  const enabledCount = jobs.filter((job) => job.enabled).length;
  const mostRecentRunAt = jobs
    .map((job) => job.lastRunAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);

  return (
    <div className="page">
      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Scheduling</p>
            <h2>Cron Jobs</h2>
            <p className="section-description">
              Run a command inside one of your apps' containers on a schedule — database
              cleanups, maintenance tasks, anything you'd normally put in a crontab.
            </p>
          </div>
          <button className="primary-button" type="button" onClick={openCreate} disabled={apps.length === 0}>
            New Cron Job
          </button>
        </div>

        {!loading && jobs.length > 0 && (
          <section className="stats-grid cron-stats">
            <StatCard label="Total Jobs" value={String(jobs.length)} hint="All cron jobs" />
            <StatCard
              label="Enabled"
              value={String(enabledCount)}
              tone={enabledCount > 0 ? "positive" : "neutral"}
              hint="Currently enabled"
            />
            <StatCard
              label="Disabled"
              value={String(jobs.length - enabledCount)}
              tone={jobs.length - enabledCount > 0 ? "warning" : "neutral"}
              hint="Currently disabled"
            />
            <StatCard
              label="Last Run (All)"
              value={mostRecentRunAt ? timeAgo(mostRecentRunAt) : "Never"}
              tone={mostRecentRunAt ? "positive" : "neutral"}
              hint="Most recent execution"
            />
          </section>
        )}

        {apps.length === 0 && (
          <div className="warning-banner">
            Create an app first — a cron job runs a command inside an app's container.
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="notice-banner">{notice}</div>}

        {loading ? (
          <div className="empty-state">Loading cron jobs…</div>
        ) : jobs.length === 0 ? (
          <div className="empty-state">No cron jobs yet.</div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="env-table cron-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>App</th>
                    <th>Schedule</th>
                    <th>Last Run</th>
                    <th>Enabled</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <div className="cron-name-cell">
                          <span className="cron-job-icon" aria-hidden="true">
                            {jobIcon(job.name)}
                          </span>
                          <div className="cron-name-meta">
                            <strong className="cron-job-name">{job.name}</strong>
                            <div className="cron-command-box">
                              <code
                                className={expandedCommandId === job.id ? "" : "cron-command-clamped"}
                              >
                                {job.command}
                              </code>
                              <div className="cron-command-tools">
                                <button
                                  type="button"
                                  className="copy-button"
                                  aria-label={
                                    expandedCommandId === job.id
                                      ? "Collapse command"
                                      : "Show full command"
                                  }
                                  aria-expanded={expandedCommandId === job.id}
                                  title={
                                    expandedCommandId === job.id
                                      ? "Collapse command"
                                      : "Show full command"
                                  }
                                  onClick={() =>
                                    setExpandedCommandId(expandedCommandId === job.id ? null : job.id)
                                  }
                                >
                                  👁
                                </button>
                                <CopyButton value={job.command} label="command" />
                              </div>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="cron-app-cell">
                          <span className="cron-app-avatar" aria-hidden="true">
                            {job.appName.charAt(0).toUpperCase()}
                          </span>
                          <span className="cron-app-name">{job.appName}</span>
                        </div>
                      </td>
                      <td>
                        <div className="cron-schedule-cell">
                          <code className="cron-schedule-expr">{job.cronExpression}</code>
                          {job.scheduleDescription && (
                            <span className="cron-subtext">{job.scheduleDescription}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        {job.lastRunAt ? (
                          <button
                            type="button"
                            className="cron-status-button"
                            onClick={() => void openHistory(job)}
                            title="View run history"
                          >
                            <span className={`status-badge ${statusTone(job.lastStatus)} compact`}>
                              {job.lastStatus}
                              {job.lastExitCode !== null ? ` (${job.lastExitCode})` : ""}
                            </span>
                            <span className="cron-subtext">
                              {new Date(job.lastRunAt).toLocaleString()}
                            </span>
                            {job.lastDurationMs !== null && (
                              <span className="cron-subtext">
                                <span aria-hidden="true">🕒</span> {formatDuration(job.lastDurationMs)}
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="text-faint">Never</span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={job.enabled}
                          aria-label={`${job.enabled ? "Disable" : "Enable"} ${job.name}`}
                          className={`cron-toggle ${job.enabled ? "on" : ""}`}
                          onClick={() => void toggleEnabled(job)}
                        >
                          <span className="cron-toggle-knob" />
                        </button>
                      </td>
                      <td>
                        <div className="cron-row-actions">
                          <button
                            className="secondary-button compact"
                            type="button"
                            onClick={() => void runNow(job)}
                            disabled={runningId === job.id}
                          >
                            {runningId === job.id ? (
                              "Running…"
                            ) : (
                              <>
                                {/* aria-hidden so the accessible name stays exactly "Run now". */}
                                <span aria-hidden="true">▷</span> Run now
                              </>
                            )}
                          </button>
                          <button
                            className="icon-button compact"
                            type="button"
                            aria-label="Edit"
                            title="Edit"
                            onClick={() => openEdit(job)}
                          >
                            ✎
                          </button>
                          <button
                            className="icon-button compact danger"
                            type="button"
                            aria-label="Delete"
                            title="Delete"
                            onClick={() => setDeleteTarget(job)}
                          >
                            🗑
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="cron-table-footer text-faint">
              Showing {jobs.length} of {jobs.length} cron job{jobs.length === 1 ? "" : "s"}
            </p>
          </>
        )}
      </section>

      {form && (
        <div className="modal-backdrop">
          <section className="form-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">{form.id === null ? "New" : "Edit"}</p>
                <h2>{form.id === null ? "New Cron Job" : "Edit Cron Job"}</h2>
              </div>
              <button className="close-button" type="button" onClick={() => setForm(null)} disabled={saving}>
                Close
              </button>
            </header>

            <div className="wizard-body">
              <label>
                <span>Name</span>
                <input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="Nightly cleanup"
                  autoFocus
                />
              </label>

              <label>
                <span>App (the command runs in this app's container)</span>
                <select
                  className="wizard-select"
                  value={form.appId ?? ""}
                  onChange={(event) => setForm({ ...form, appId: Number(event.target.value) })}
                >
                  {apps.map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Command</span>
                <input
                  value={form.command}
                  onChange={(event) => setForm({ ...form, command: event.target.value })}
                  placeholder="php artisan schedule:run"
                  autoComplete="off"
                  spellCheck={false}
                />
                <small>Run with <code>sh -c</code> inside the container, as the container's user.</small>
              </label>

              <label>
                <span>Schedule (cron expression)</span>
                <input
                  value={form.cronExpression}
                  onChange={(event) => setForm({ ...form, cronExpression: event.target.value })}
                  placeholder="0 3 * * *"
                  spellCheck={false}
                  autoComplete="off"
                />
                <div className="cron-presets">
                  {COMMON_SCHEDULES.map((preset) => (
                    <button
                      key={preset.expr}
                      type="button"
                      className="cron-preset"
                      onClick={() => setForm({ ...form, cronExpression: preset.expr })}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <small className={preview.valid ? "cron-preview-ok" : "cron-preview-bad"}>
                  {preview.text || "Enter a 5-field cron expression."}
                </small>
              </label>

              <label>
                <span>Timeout (seconds)</span>
                <input
                  type="number"
                  min="1"
                  max="3600"
                  value={form.timeoutSeconds}
                  onChange={(event) => setForm({ ...form, timeoutSeconds: event.target.value })}
                />
                <small>The command is killed if it runs longer than this.</small>
              </label>

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                />
                <span>Enabled (runs on schedule)</span>
              </label>

              {formError && <div className="error-banner">{formError}</div>}
            </div>

            <div className="form-actions">
              <button className="secondary-button" type="button" onClick={() => setForm(null)} disabled={saving}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void saveForm()}
                disabled={saving || !preview.valid || !form.name.trim() || !form.command.trim()}
              >
                {saving ? "Saving…" : form.id === null ? "Create" : "Save"}
              </button>
            </div>
          </section>
        </div>
      )}

      {historyJob && (
        <div className="modal-backdrop" onClick={() => setHistoryJob(null)}>
          <section className="form-modal cron-history-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Run history</p>
                <h2>{historyJob.name}</h2>
              </div>
              <button className="close-button" type="button" onClick={() => setHistoryJob(null)}>
                Close
              </button>
            </header>

            <div className="wizard-body">
              {runsError && <div className="error-banner">{runsError}</div>}

              {runsLoading ? (
                <div className="empty-state">Loading run history…</div>
              ) : runs.length === 0 ? (
                <div className="empty-state">This job hasn't run yet.</div>
              ) : (
                <div className="cron-history">
                  <ul className="cron-run-list">
                    {runs.map((run) => (
                      <li key={run.id}>
                        <button
                          type="button"
                          className={`cron-run-item ${selectedRun?.id === run.id ? "active" : ""}`}
                          onClick={() => setSelectedRun(run)}
                        >
                          <span className={`status-badge ${statusTone(run.status)} compact`}>
                            {run.status}
                            {run.exitCode !== null ? ` (${run.exitCode})` : ""}
                          </span>
                          <span className="cron-run-time">
                            {new Date(run.ranAt).toLocaleString()}
                          </span>
                          <span className="text-faint">{formatDuration(run.durationMs)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>

                  <div className="cron-run-output">
                    {selectedRun ? (
                      <div className="brief-box">
                        <pre>{selectedRun.output || "(no output)"}</pre>
                      </div>
                    ) : (
                      <div className="empty-state">Select a run to see its output.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      <ConfirmationDialog
        open={deleteTarget !== null}
        title="Delete cron job"
        message={`Delete "${deleteTarget?.name}"? It will stop running on its schedule.`}
        confirmLabel="Delete"
        confirmingLabel="Deleting…"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
