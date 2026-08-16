import { useEffect, useState } from "react";
import type {
  ConnectionFormValues,
  DatabaseConnectionKind
} from "../types/api";

interface ConnectionDialogProps {
  open: boolean;
  title: string;
  /** On edit, the string can be left blank to keep the stored one. */
  editing?: boolean;
  initialValues?: Partial<ConnectionFormValues>;
  submitting: boolean;
  error: string;
  onSubmit: (values: ConnectionFormValues) => void;
  onCancel: () => void;
}

export const CONNECTION_KIND_OPTIONS: {
  value: DatabaseConnectionKind;
  label: string;
  /** A sensible default variable name for this kind, offered as a placeholder. */
  suggestedKey: string;
}[] = [
  { value: "mongodb", label: "MongoDB", suggestedKey: "MONGODB_URI" },
  { value: "postgres", label: "PostgreSQL", suggestedKey: "DATABASE_URL" },
  { value: "mysql", label: "MySQL", suggestedKey: "MYSQL_URL" },
  { value: "redis", label: "Redis", suggestedKey: "REDIS_URL" },
  { value: "sqlite", label: "SQLite", suggestedKey: "DATABASE_URL" },
  { value: "other", label: "Other", suggestedKey: "DATABASE_URL" }
];

const EMPTY_VALUES: ConnectionFormValues = {
  name: "",
  kind: "mongodb",
  connectionString: "",
  envKey: "",
  injectGlobally: true
};

export default function ConnectionDialog({
  open,
  title,
  editing = false,
  initialValues,
  submitting,
  error,
  onSubmit,
  onCancel
}: ConnectionDialogProps) {
  const [values, setValues] = useState<ConnectionFormValues>({
    ...EMPTY_VALUES,
    ...initialValues
  });
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    if (open) {
      setValues({ ...EMPTY_VALUES, ...initialValues });
      setReveal(false);
    }
    // Only reset when the dialog opens, not on every initialValues change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) {
    return null;
  }

  const suggestedKey =
    CONNECTION_KIND_OPTIONS.find((option) => option.value === values.kind)
      ?.suggestedKey ?? "DATABASE_URL";

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
            <p className="eyebrow">Database Connection</p>
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
          {error && <div className="error-banner">{error}</div>}

          <label>
            <span>Name</span>
            <input
              value={values.name}
              onChange={(event) =>
                setValues((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="Atlas — Production"
              disabled={submitting}
              required
              autoFocus
            />
            <small>A friendly label so you can tell your connections apart.</small>
          </label>

          <label>
            <span>Type</span>
            <select
              value={values.kind}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  kind: event.target.value as DatabaseConnectionKind
                }))
              }
              disabled={submitting}
            >
              {CONNECTION_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Connection string</span>
            <input
              type={reveal ? "text" : "password"}
              value={values.connectionString}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  connectionString: event.target.value
                }))
              }
              placeholder={
                editing
                  ? "Leave blank to keep the current connection string"
                  : "mongodb+srv://user:password@cluster0.abcde.mongodb.net/"
              }
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="inline-field-actions">
              <button
                type="button"
                className="link-button"
                onClick={() => setReveal((shown) => !shown)}
                disabled={submitting}
              >
                {reveal ? "Hide" : "Show"}
              </button>
              {editing && (
                <small>Stored securely. Leave blank to keep the existing one.</small>
              )}
            </div>
          </label>

          <label>
            <span>Variable name (optional)</span>
            <input
              value={values.envKey}
              onChange={(event) =>
                setValues((current) => ({ ...current, envKey: event.target.value }))
              }
              placeholder={suggestedKey}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
            />
            <small>
              The environment variable your apps read this connection from (e.g.{" "}
              <code>{suggestedKey}</code>). Leave blank to keep it copy-only.
            </small>
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={values.injectGlobally}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  injectGlobally: event.target.checked
                }))
              }
              disabled={submitting || values.envKey.trim() === ""}
            />
            <span>
              Add to every app now — inject it into the global environment as a
              secret variable.
            </span>
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
              {submitting ? "Saving..." : "Save Connection"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
