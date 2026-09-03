export type MoveDirection = "global-to-app" | "app-to-global";
export type MoveDisposition = "disable" | "delete";

interface MoveVariableDialogProps {
  open: boolean;
  keys: string[];
  direction: MoveDirection;
  submitting: boolean;
  error: string;
  onDispose: (disposition: MoveDisposition) => void;
  onCancel: () => void;
}

/**
 * Confirms moving one or more environment variables between the global scope
 * and an app's scope, and asks what to do with the copies they moved OUT of —
 * disable them (kept but inactive) or delete them outright.
 */
export default function MoveVariableDialog({
  open,
  keys,
  direction,
  submitting,
  error,
  onDispose,
  onCancel
}: MoveVariableDialogProps) {
  if (!open || keys.length === 0) {
    return null;
  }

  const toApp = direction === "global-to-app";
  const destination = toApp ? "this app" : "the global scope (every app)";
  const sourceWord = toApp ? "global variable" : "app copy";
  const sourceWordPlural = toApp ? "global variables" : "app copies";
  const many = keys.length > 1;
  const subjectPlural = many ? sourceWordPlural : sourceWord;
  const shortSource = toApp ? "global" : "app copy";

  return (
    <div className="modal-backdrop">
      <section className="form-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">Move variable{many ? "s" : ""}</p>
            <h2>{many ? `Move ${keys.length} variables` : `Move ${keys[0]}`}</h2>
          </div>
          <button className="close-button" type="button" disabled={submitting} onClick={onCancel}>
            Close
          </button>
        </header>

        <div className="form-modal-body">
          {error && <div className="error-banner">{error}</div>}

          <p className="dialog-description">
            {many ? (
              <>Copies {keys.length} variables into {destination}, keeping each value and secret setting.</>
            ) : (
              <>
                Copies <code>{keys[0]}</code> into {destination}, keeping its value and secret setting.
              </>
            )}
            {toApp
              ? " Other apps that inherit these global variables are affected by what you choose below."
              : ""}
          </p>

          {many && (
            <ul className="move-variable-keys">
              {keys.map((key) => (
                <li key={key}>
                  <code>{key}</code>
                </li>
              ))}
            </ul>
          )}

          <p className="dialog-description">
            What should happen to the original <strong>{subjectPlural}</strong>?
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
              {submitting ? "Working…" : `Move & disable ${shortSource}${many ? "s" : ""}`}
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={submitting}
              onClick={() => onDispose("delete")}
            >
              {submitting ? "Working…" : `Move & delete ${shortSource}${many ? "s" : ""}`}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
