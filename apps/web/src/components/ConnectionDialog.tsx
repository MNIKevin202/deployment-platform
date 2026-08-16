import { useEffect, useState } from "react";
import type {
  ConnectionFormValues,
  DatabaseConnectionKind
} from "../types/api";

interface ConnectionTestOutcome {
  reachable: boolean;
  message: string;
}

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
  /** Runs a reachability probe. Receives the current form string (may be blank
   * on an edit, in which case the caller tests the stored connection). */
  onTest?: (connectionString: string) => Promise<ConnectionTestOutcome>;
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
  onCancel,
  onTest
}: ConnectionDialogProps) {
  const [values, setValues] = useState<ConnectionFormValues>({
    ...EMPTY_VALUES,
    ...initialValues
  });
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestOutcome | null>(null);

  useEffect(() => {
    if (open) {
      setValues({ ...EMPTY_VALUES, ...initialValues });
      setReveal(false);
      setTesting(false);
      setTestResult(null);
    }
    // Only reset when the dialog opens, not on every initialValues change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) {
    return null;
  }

  const canTest = Boolean(onTest) && (values.connectionString.trim() !== "" || editing);

  const runTest = async () => {
    if (!onTest) {
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await onTest(values.connectionString));
    } catch (error) {
      setTestResult({
        reachable: false,
        message: error instanceof Error ? error.message : "Test failed"
      });
    } finally {
      setTesting(false);
    }
  };

  const suggestedKey =
    CONNECTION_KIND_OPTIONS.find((option) => option.value === values.kind)
      ?.suggestedKey ?? "DATABASE_URL";

  return (
    // The backdrop deliberately does NOT close the dialog on click — a stray
    // click outside shouldn't discard a half-entered connection. Close only via
    // the Close / Cancel buttons.
    <div className="modal-backdrop">
      <section
        className="form-modal connection-modal"
        onClick={(event) => event.stopPropagation()}
      >
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

          <div className="field">
            <span className="field-label">Type</span>
            <div
              className="connection-kind-grid"
              role="group"
              aria-label="Database type"
            >
              {CONNECTION_KIND_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`kind-chip ${values.kind === option.value ? "active" : ""}`}
                  data-kind={option.value}
                  aria-pressed={values.kind === option.value}
                  disabled={submitting}
                  onClick={() =>
                    setValues((current) => ({ ...current, kind: option.value }))
                  }
                >
                  <span className="kind-dot" aria-hidden="true" />
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <label>
            <span>Connection string</span>
            <div className="input-affix">
              <input
                className="mono"
                type={reveal ? "text" : "password"}
                value={values.connectionString}
                onChange={(event) => {
                  setTestResult(null);
                  setValues((current) => ({
                    ...current,
                    connectionString: event.target.value
                  }));
                }}
                placeholder={
                  editing
                    ? "Leave blank to keep the current connection string"
                    : "mongodb+srv://user:password@cluster0.abcde.mongodb.net/"
                }
                disabled={submitting}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="input-affix-btn"
                onClick={() => setReveal((shown) => !shown)}
                disabled={submitting}
              >
                {reveal ? "Hide" : "Show"}
              </button>
            </div>
            <small>
              {editing
                ? "Stored securely. Leave blank to keep the existing one."
                : "Stored securely — never shown again in full once saved."}
            </small>

            {onTest && (
              <div className="connection-test-row">
                <button
                  type="button"
                  className="secondary-button compact"
                  onClick={() => void runTest()}
                  disabled={submitting || testing || !canTest}
                >
                  {testing ? "Testing…" : "Test connection"}
                </button>
                {testResult && (
                  <span
                    className={`connection-test-result ${testResult.reachable ? "ok" : "fail"}`}
                    role="status"
                  >
                    {testResult.reachable ? "✓ " : "✗ "}
                    {testResult.message}
                  </span>
                )}
              </div>
            )}
          </label>

          <div className="connection-share-card">
            <p className="share-card-title">Make it available to your apps</p>

            <label>
              <span>Variable name (optional)</span>
              <input
                className="mono"
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
          </div>

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
