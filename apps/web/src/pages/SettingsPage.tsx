import { useRef, useState } from "react";
import ConfirmationDialog from "../components/ConfirmationDialog";
import Tabs from "../components/Tabs";
import AccountSettings from "../components/AccountSettings";
import DiskSettings from "../components/DiskSettings";
import SpeedtestSettings from "../components/SpeedtestSettings";
import NotificationSettings from "../components/NotificationSettings";
import BackupScheduleSettings from "../components/BackupScheduleSettings";
import UpdatesSettings from "../components/UpdatesSettings";
import type { ApiError } from "../types/api";

interface RestoreResponse {
  success: boolean;
  message: string;
}

type SettingsTab = "account" | "notifications" | "integrations" | "backups" | "maintenance" | "updates";

const SETTINGS_TABS = [
  { key: "account", label: "Account" },
  { key: "notifications", label: "Notifications" },
  { key: "integrations", label: "Integrations" },
  { key: "backups", label: "Backups" },
  { key: "maintenance", label: "Maintenance" },
  { key: "updates", label: "Updates" }
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("account");

  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const downloadBackup = () => {
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
      window.setTimeout(() => window.location.reload(), 7000);
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "Restore failed.");
      setConfirming(false);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="page settings-page">
      <Tabs items={SETTINGS_TABS} active={tab} onChange={(key) => setTab(key as SettingsTab)} />

      {tab === "account" && <AccountSettings />}

      {tab === "notifications" && <NotificationSettings />}

      {tab === "integrations" && <SpeedtestSettings />}

      {tab === "maintenance" && <DiskSettings />}

      {tab === "updates" && <UpdatesSettings />}

      {tab === "backups" && (
        <>
          <BackupScheduleSettings />

          {restored && (
            <div className="notice-banner">
              Backup restored. The platform is restarting to load it — this page will reload in a few
              seconds. You may need to sign in again.
            </div>
          )}

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
              <strong>overwrites everything</strong> and restarts the platform. Your apps' containers
              keep running; their definitions are replaced by the backup's.
            </p>

            {error && <div className="error-banner">{error}</div>}

            <div className="form-actions form-actions-start">
              <input
                ref={fileInputRef}
                type="file"
                accept=".gz,.tgz,.tar.gz,application/gzip"
                className="settings-file-input"
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
        </>
      )}

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
