import { useEffect, useState } from "react";

interface EnvironmentExportDialogProps {
  open: boolean;
  submitting: boolean;
  error: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export default function EnvironmentExportDialog({
  open,
  submitting,
  error,
  onSubmit,
  onCancel
}: EnvironmentExportDialogProps) {
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (open) setPassword("");
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={() => !submitting && onCancel()}>
      <section className="form-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">Protected Export</p>
            <h2>Copy environment variables</h2>
          </div>
          <button className="close-button" type="button" disabled={submitting} onClick={onCancel}>
            Close
          </button>
        </header>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(password);
          }}
        >
          <p className="dialog-description">
            Enter the environment export password configured during installation. Secret values will be copied to your clipboard.
          </p>
          {error && <div className="error-banner">{error}</div>}
          <label>
            <span>Environment export password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
              disabled={submitting}
              required
              autoFocus
            />
          </label>
          <div className="form-actions">
            <button className="secondary-button" type="button" disabled={submitting} onClick={onCancel}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={submitting || !password}>
              {submitting ? "Verifying..." : "Copy all"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
