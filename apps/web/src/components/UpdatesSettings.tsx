import { useEffect, useState } from "react";
import { checkForUpdate, type UpdateStatus } from "../lib/updateCheck";

export default function UpdatesSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [error, setError] = useState("");

  const check = async () => {
    try {
      setChecking(true);
      setError("");
      const next = await checkForUpdate();
      setStatus(next);
      setCheckedAt(new Date());
    } catch {
      setError("Couldn't check for updates. Try again in a moment.");
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check();
  }, []);

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Updates</p>
          <h2>Check for updates</h2>
        </div>
      </div>

      <p className="text-faint">
        Checks whether a newer version of the panel has been deployed than the one this tab is running.
        Updating isn't required — reloading loads the new version. Everything is checked in your browser.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="settings-form">
        {status && !checking && (
          <p className={status.updateAvailable ? "update-status update-status-available" : "update-status update-status-current"}>
            {status.updateAvailable
              ? "A new version is available."
              : "You're running the latest version."}
          </p>
        )}
        {checkedAt && <p className="text-faint">Last checked {checkedAt.toLocaleTimeString()}.</p>}
        <p className="text-faint">
          This tab's build: <code className="inline-code">{__BUILD_ID__}</code>
        </p>

        <div className="form-actions form-actions-start">
          <button className="secondary-button" type="button" onClick={() => void check()} disabled={checking}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
          {status?.updateAvailable && (
            <button className="primary-button" type="button" onClick={() => window.location.reload()}>
              Reload to update
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
