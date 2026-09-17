import { useEffect, useRef } from "react";

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
 *
 * Accessibility: role=alertdialog + aria-modal, labelled and described; Escape
 * cancels (unless mid-confirm); focus moves to the primary action on open, is
 * trapped within the dialog, and is restored to the trigger on close.
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
  const dialogRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    previouslyFocused.current = document.activeElement;
    // Focus the primary action once rendered.
    const focusTimer = window.setTimeout(() => confirmRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirming) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to whatever opened the dialog.
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [open, confirming, onCancel]);

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
        aria-describedby="update-confirm-desc"
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="update-confirm-title">ClovaForge Update</h2>

        <div id="update-confirm-desc" className="update-confirm-versions">
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
              <span>{c.label}</span>
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
          <button type="button" className="primary-button" ref={confirmRef} onClick={onConfirm} disabled={confirming}>
            {confirming ? "Starting…" : "Install Update"}
          </button>
        </div>
      </section>
    </div>
  );
}
