export type MoveDirection = "global-to-app" | "app-to-global";
export type MoveDisposition = "disable" | "delete";

interface MoveVariableDialogProps {
  open: boolean;
  keyName: string;
  direction: MoveDirection;
  submitting: boolean;
  error: string;
  onDispose: (disposition: MoveDisposition) => void;
  onCancel: () => void;
}

/**
 * Confirms moving an environment variable between the global scope and an
 * app's scope, and asks what to do with the copy it moved OUT of — disable it
 * (kept but inactive) or delete it outright.
 */
export default function MoveVariableDialog({
  open,
  keyName,
  direction,
  submitting,
  error,
  onDispose,
  onCancel
}: MoveVariableDialogProps) {
  if (!open) {
    return null;
  }

  const toApp = direction === "global-to-app";
  const destination = toApp ? "this app" : "the global scope (every app)";
  const sourceWord = toApp ? "global variable" : "app copy";

  return (
    <div className="modal-backdrop">
      <section className="form-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">Move variable</p>
            <h2>Move {keyName}</h2>
          </div>
          <button className="close-button" type="button" disabled={submitting} onClick={onCancel}>
            Close
          </button>
        </header>

        <div className="form-modal-body">
          {error && <div className="error-banner">{error}</div>}

          <p className="dialog-description">
            This copies <code>{keyName}</code> into {destination}, keeping its
            value and secret setting.
            {toApp
              ? " Other apps that inherit this global variable are affected by what you choose below."
              : ""}
          </p>

          <p className="dialog-description">
            What should happen to the original <strong>{sourceWord}</strong>?
          </p>

          <div className="form-actions move-variable-actions">
            <button className="secondary-button" type="button" disabled={submitting} onClick={onCancel}>
              Cancel
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={submitting}
              onClick={() => onDispose("disable")}
            >
              {submitting ? "Working…" : `Move & disable ${toApp ? "global" : "app copy"}`}
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={submitting}
              onClick={() => onDispose("delete")}
            >
              {submitting ? "Working…" : `Move & delete ${toApp ? "global" : "app copy"}`}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
