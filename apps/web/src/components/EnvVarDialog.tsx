import { useEffect, useState } from "react";
import type { EnvVarFormValues } from "../types/api";

interface EnvVarDialogProps {
  open: boolean;
  title: string;
  description?: string;
  keyLocked?: boolean;
  initialValues?: Partial<EnvVarFormValues>;
  secretValuePlaceholder?: string;
  submitting: boolean;
  error: string;
  onSubmit: (values: EnvVarFormValues) => void;
  onCancel: () => void;
}

const EMPTY_VALUES: EnvVarFormValues = {
  key: "",
  value: "",
  isSecret: false,
  enabled: true
};

export default function EnvVarDialog({
  open,
  title,
  description,
  keyLocked = false,
  initialValues,
  secretValuePlaceholder,
  submitting,
  error,
  onSubmit,
  onCancel
}: EnvVarDialogProps) {
  const [values, setValues] = useState<EnvVarFormValues>({
    ...EMPTY_VALUES,
    ...initialValues
  });

  useEffect(() => {
    if (open) {
      setValues({ ...EMPTY_VALUES, ...initialValues });
    }
    // Only reset when the dialog opens, not on every initialValues identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!submitting) {
          onCancel();
        }
      }}
    >
      <section className="form-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">Environment Variable</p>
            <h2>{title}</h2>
          </div>

          <button
            className="close-button"
            type="button"
            disabled={submitting}
            onClick={onCancel}
          >
            Close
          </button>
        </header>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(values);
          }}
        >
          {description && <p className="dialog-description">{description}</p>}

          {error && <div className="error-banner">{error}</div>}

          <label>
            <span>Key</span>
            <input
              value={values.key}
              onChange={(event) =>
                setValues((current) => ({ ...current, key: event.target.value }))
              }
              placeholder="API_URL"
              disabled={keyLocked || submitting}
              required
              autoFocus
            />
            <small>Letters, numbers, and underscores only. Cannot start with a number.</small>
          </label>

          <label>
            <span>Value</span>
            <input
              type={values.isSecret ? "password" : "text"}
              value={values.value}
              onChange={(event) =>
                setValues((current) => ({ ...current, value: event.target.value }))
              }
              placeholder={secretValuePlaceholder ?? "https://example.com"}
              disabled={submitting}
              autoComplete="off"
            />
            {secretValuePlaceholder && (
              <small>{secretValuePlaceholder}</small>
            )}
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={values.isSecret}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  isSecret: event.target.checked
                }))
              }
              disabled={submitting}
            />
            <span>Secret — mask this value everywhere it's shown</span>
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={values.enabled}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  enabled: event.target.checked
                }))
              }
              disabled={submitting}
            />
            <span>Enabled — include in the effective environment</span>
          </label>

          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={submitting}
              onClick={onCancel}
            >
              Cancel
            </button>

            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
