import { useRef, useState } from "react";
import ConfirmationDialog from "../components/ConfirmationDialog";
import AccountSettings from "../components/AccountSettings";
import DiskSettings from "../components/DiskSettings";
import type { ApiError } from "../types/api";

interface RestoreResponse {
  success: boolean;
  message: string;
}

export default function SettingsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const downloadBackup = () => {
    // A same-origin GET carries the auth cookie; the server sets the
    // Content-Disposition filename.
    const link = document.createElement("a");
    link.href = "/api/settings/backup";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const runRestore = async () => {
    if (!file) {
      return;
    }

    try {
      setRestoring(true);
      setError("");

      const response = await fetch("/api/settings/restore", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file
      });

      const result = (await response.json().catch(() => null)) as
        | (RestoreResponse & ApiError)
        | null;

      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Restore failed.");
      }

      setConfirming(false);
      setRestored(true);
      // The API restarts to load the restored database; reload shortly so the
      // panel reconnects (you may need to sign in again).
      window.setTimeout(() => window.location.reload(), 7000);
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "Restore failed.");
      setConfirming(false);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="page">
      {restored && (
        <div className="notice-banner">
          Backup restored. The platform is restarting to load it — this page will reload in a few
          seconds. You may need to sign in again.
        </div>
      )}

      <AccountSettings />

      <DiskSettings />

      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Backup</p>
            <h2>Download a backup</h2>
          </div>
        </div>

        <p className="text-faint">
          Downloads a single archive of your entire platform configuration — every app, GitHub
          source, environment variable and secret, stored credential, and deployment history.
          <strong> Keep it somewhere safe: it contains your secrets.</strong>
        </p>

        <div className="form-actions form-actions-start">
          <button className="primary-button" type="button" onClick={downloadBackup}>
            Download backup
          </button>
        </div>
      </section>

      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Restore</p>
            <h2>Restore from a backup</h2>
          </div>
        </div>

        <p className="text-faint">
          Upload a backup archive to replace the platform's current configuration. This{" "}
          <strong>overwrites everything</strong> and restarts the platform. Your apps' containers keep
          running; their definitions are replaced by the backup's.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <div className="form-actions form-actions-start">
          <input
            ref={fileInputRef}
            type="file"
            accept=".gz,.tgz,.tar.gz,application/gzip"
            className="wizard-input"
            disabled={restoring || restored}
            onChange={(event) => {
              setError("");
              setFile(event.target.files?.[0] ?? null);
            }}
          />
          <button
            className="danger-button"
            type="button"
            disabled={!file || restoring || restored}
            onClick={() => setConfirming(true)}
          >
            Restore &amp; restart
          </button>
        </div>
        {file && <p className="text-faint">Selected: {file.name}</p>}
      </section>

      <ConfirmationDialog
        open={confirming}
        title="Restore from backup?"
        danger
        message={
          <>
            This replaces the platform's <strong>entire current configuration</strong> with the
            contents of <strong>{file?.name}</strong> and restarts the platform. A safety copy of the
            current database is kept on the server first. This cannot be undone from here.
          </>
        }
        confirmLabel="Restore & restart"
        confirmingLabel="Restoring..."
        confirming={restoring}
        onConfirm={() => void runRestore()}
        onCancel={() => {
          if (!restoring) {
            setConfirming(false);
          }
        }}
      />
    </div>
  );
}
