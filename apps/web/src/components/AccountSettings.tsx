import { useState } from "react";
import type { ApiError } from "../types/api";

export default function AccountSettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");

    if (newPassword.length < 8) {
      setError("Your new password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The new password and confirmation do not match.");
      return;
    }

    try {
      setSaving(true);
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const result = (await response.json().catch(() => null)) as (ApiError & { success?: boolean }) | null;

      if (!response.ok || !result?.success) {
        throw new Error(result?.message || "Unable to change password.");
      }

      setNotice(result.message || "Password updated.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to change password.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Account</p>
          <h2>Change password</h2>
        </div>
      </div>

      <p className="text-faint">
        Update the owner password used to sign in. You'll use the new password the next time you log
        in; your current session stays active.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <form onSubmit={(event) => void submit(event)} className="settings-form">
        <label>
          <span>Current password</span>
          <input
            type="password"
            className="wizard-input"
            value={currentPassword}
            autoComplete="current-password"
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label>
          <span>New password</span>
          <input
            type="password"
            className="wizard-input"
            value={newPassword}
            autoComplete="new-password"
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <label>
          <span>Confirm new password</span>
          <input
            type="password"
            className="wizard-input"
            value={confirmPassword}
            autoComplete="new-password"
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </label>

        <div className="form-actions form-actions-start">
          <button
            className="primary-button"
            type="submit"
            disabled={saving || !currentPassword || !newPassword}
          >
            {saving ? "Updating…" : "Update password"}
          </button>
        </div>
      </form>
    </section>
  );
}
