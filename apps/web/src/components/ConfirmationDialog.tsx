import type { ReactNode } from "react";

interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  /** Shown on the confirm button in place of confirmLabel while confirming. */
  confirmingLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  confirming?: boolean;
  /**
   * Shown INSIDE the dialog. This modal covers the whole page (fixed,
   * inset: 0), so an error set on the page behind it — the earlier pattern —
   * is invisible for as long as the dialog stays open.
   */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmationDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  confirmingLabel = "Working...",
  cancelLabel = "Cancel",
  danger = false,
  confirming = false,
  error = "",
  onConfirm,
  onCancel
}: ConfirmationDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!confirming) {
          onCancel();
        }
      }}
    >
      <section
        className="confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <div className="confirm-modal-message">{message}</div>

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        <div className="form-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={confirming}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>

          <button
            className={danger ? "danger-button" : "primary-button"}
            type="button"
            disabled={confirming}
            onClick={onConfirm}
            autoFocus
          >
            {confirming ? confirmingLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
