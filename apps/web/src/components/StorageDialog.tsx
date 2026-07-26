import { useEffect, useState } from "react";
import type { StorageFormValues } from "../types/api";

interface StorageDialogProps {
  open: boolean;
  title: string;
  description?: string;
  volumeNameLocked?: boolean;
  initialValues?: Partial<StorageFormValues>;
  submitting: boolean;
  error: string;
  onSubmit: (values: StorageFormValues) => void;
  onCancel: () => void;
}

const EMPTY_VALUES: StorageFormValues = {
  containerPath: "",
  volumeName: "",
  readOnly: false
};

export default function StorageDialog({
  open,
  title,
  description,
  volumeNameLocked = false,
  initialValues,
  submitting,
  error,
  onSubmit,
  onCancel
}: StorageDialogProps) {
  const [values, setValues] = useState<StorageFormValues>({
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
            <p className="eyebrow">Persistent Storage</p>
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
            <span>Container path</span>
            <input
              value={values.containerPath}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  containerPath: event.target.value
                }))
              }
              placeholder="/data"
              disabled={submitting}
              required
              autoFocus
            />
            <small>
              Absolute path inside the container, such as /data, /config, or
              /app/storage.
            </small>
          </label>

          <label>
            <span>Volume name{volumeNameLocked ? "" : " (optional)"}</span>
            <input
              value={values.volumeName}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  volumeName: event.target.value
                }))
              }
              placeholder="Leave blank to generate automatically"
              disabled={volumeNameLocked || submitting}
            />
            <small>
              {volumeNameLocked
                ? "Volume names cannot be changed after creation — delete and recreate this mount to use a different volume."
                : "Lowercase letters, numbers, hyphens, and underscores only. Leave blank to let the platform generate a safe name."}
            </small>
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={values.readOnly}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  readOnly: event.target.checked
                }))
              }
              disabled={submitting}
            />
            <span>Read-only — mount this volume without write access</span>
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
