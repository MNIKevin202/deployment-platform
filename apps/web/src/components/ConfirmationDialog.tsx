import type { ReactNode } from "react";

interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  confirming?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmationDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  confirming = false,
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
            {confirming ? "Working..." : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
