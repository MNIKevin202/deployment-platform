interface UpdateConfirmModalProps {
  open: boolean;
  currentVersion: string;
  newVersion: string;
  signedVerified: boolean;
  compatible: boolean;
  rollbackSafe: boolean;
  confirming: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Pre-flight confirmation for a platform self-update. Purely presentational —
 * the real verification/backup/rollback is the host updater's job; this just
 * states, in plain language, what is about to happen so an admin confirms
 * intentionally. Matches the existing modal-backdrop/confirm-modal design.
 */
export default function UpdateConfirmModal({
  open,
  currentVersion,
  newVersion,
  signedVerified,
  compatible,
  rollbackSafe,
  confirming,
  error,
  onConfirm,
  onCancel
}: UpdateConfirmModalProps) {
  if (!open) {
    return null;
  }

  const checks: { ok: boolean; label: string }[] = [
    { ok: signedVerified, label: "Signed release verified" },
    { ok: compatible, label: "Compatible with this installation" },
    { ok: true, label: "A database backup will be created automatically" },
    { ok: rollbackSafe, label: "Automatic rollback is available if verification fails" }
  ];

  return (
    <div className="modal-backdrop" onClick={() => (confirming ? undefined : onCancel())}>
      <section
        className="confirm-modal update-confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="update-confirm-title">ClovaForge Update</h2>

        <div className="update-confirm-versions">
          <div>
            <span className="update-confirm-label">Current version</span>
            <span className="update-confirm-version">{currentVersion}</span>
          </div>
          <span className="update-confirm-arrow" aria-hidden="true">→</span>
          <div>
            <span className="update-confirm-label">New version</span>
            <span className="update-confirm-version update-confirm-version-new">{newVersion}</span>
          </div>
        </div>

        <ul className="update-confirm-checks">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? "ok" : "warn"}>
              <span aria-hidden="true" className="update-confirm-tick">{c.ok ? "✓" : "!"}</span>
              {c.label}
            </li>
          ))}
        </ul>

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        <div className="confirm-modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={confirming}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={onConfirm} disabled={confirming}>
            {confirming ? "Starting…" : "Install Update"}
          </button>
        </div>
      </section>
    </div>
  );
}
