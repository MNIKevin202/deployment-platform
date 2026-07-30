import { useEffect, useMemo, useState } from "react";

interface BulkEnvVarDialogProps {
  open: boolean;
  existingSecrets: ReadonlyMap<string, boolean>;
  submitting: boolean;
  error: string;
  onSubmit: (
    variables: { key: string; value: string; isSecret: boolean }[]
  ) => void;
  onCancel: () => void;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ParsedLine {
  line: number;
  raw: string;
  key: string | null;
  value: string;
  error: string | null;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];

    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }

  return value;
}

function parseText(text: string): ParsedLine[] {
  const lines = text.split(/\r?\n/);
  const results: ParsedLine[] = [];

  lines.forEach((raw, index) => {
    const trimmed = raw.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      results.push({
        line: index + 1,
        raw,
        key: null,
        value: "",
        error: "Missing \"=\" — expected KEY=value"
      });
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = stripQuotes(trimmed.slice(separatorIndex + 1).trim());

    if (!KEY_PATTERN.test(key)) {
      results.push({
        line: index + 1,
        raw,
        key,
        value,
        error:
          "Key must start with a letter or underscore and contain only letters, numbers, and underscores"
      });
      return;
    }

    results.push({ line: index + 1, raw, key, value, error: null });
  });

  return results;
}

export default function BulkEnvVarDialog({
  open,
  existingSecrets,
  submitting,
  error,
  onSubmit,
  onCancel
}: BulkEnvVarDialogProps) {
  const [text, setText] = useState("");
  const [secretOverrides, setSecretOverrides] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    if (open) {
      setText("");
      setSecretOverrides({});
    }
  }, [open]);

  const parsed = useMemo(() => parseText(text), [text]);

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const item of parsed) {
      if (!item.key || item.error) {
        continue;
      }

      if (seen.has(item.key)) {
        duplicates.add(item.key);
      }

      seen.add(item.key);
    }

    return duplicates;
  }, [parsed]);

  const validEntries = parsed.filter(
    (item) => item.key && !item.error && !duplicateKeys.has(item.key)
  );
  const hasBlockingErrors =
    parsed.some((item) => item.error !== null) || duplicateKeys.size > 0;
  const createCount = validEntries.filter(
    (item) => !existingSecrets.has(item.key as string)
  ).length;
  const updateCount = validEntries.length - createCount;

  const isSecretFor = (key: string): boolean =>
    secretOverrides[key] ?? existingSecrets.get(key) ?? false;

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
      <section
        className="form-modal wide"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">Environment Variables</p>
            <h2>Paste Variables</h2>
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

            if (hasBlockingErrors || validEntries.length === 0) {
              return;
            }

            onSubmit(
              validEntries.map((item) => {
                const key = item.key as string;
                return {
                  key,
                  value: item.value,
                  isSecret: isSecretFor(key)
                };
              })
            );
          }}
        >
          <p className="dialog-description">
            Paste one <code>KEY=value</code> pair per line. Existing keys are
            updated in place; new keys are added. Blank lines and lines
            starting with <code>#</code> are ignored. Use the checkbox on each
            row to mark that variable as secret.
          </p>

          {error && <div className="error-banner">{error}</div>}

          <label>
            <span>Variables</span>
            <textarea
              className="bulk-env-textarea"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={"mongo=http://123456\nusername=testing"}
              disabled={submitting}
              rows={10}
              spellCheck={false}
              autoFocus
            />
          </label>

          {parsed.length > 0 && (
            <div className="bulk-env-preview">
              <div className="table-wrap">
                <table className="env-table">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Key</th>
                      <th>Value</th>
                      <th>Secret</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.map((item) => {
                      const isDuplicate = item.key
                        ? duplicateKeys.has(item.key)
                        : false;
                      const rowError = item.error
                        ? item.error
                        : isDuplicate
                          ? "Duplicate key in this paste"
                          : null;

                      return (
                        <tr
                          key={item.line}
                          className={rowError ? "bulk-env-row-error" : undefined}
                        >
                          <td className="text-faint">{item.line}</td>
                          <td className="env-key-cell">
                            <code>{item.key ?? item.raw}</code>
                          </td>
                          <td className="env-value-cell">
                            {rowError ? (
                              <span className="text-faint">—</span>
                            ) : (
                              <code>{item.value || "(empty)"}</code>
                            )}
                          </td>
                          <td>
                            {rowError || !item.key ? (
                              <span className="text-faint">—</span>
                            ) : (
                              <input
                                type="checkbox"
                                aria-label={`Mark ${item.key} as secret`}
                                checked={isSecretFor(item.key)}
                                disabled={submitting}
                                onChange={(event) => {
                                  const key = item.key as string;
                                  setSecretOverrides((current) => ({
                                    ...current,
                                    [key]: event.target.checked
                                  }));
                                }}
                              />
                            )}
                          </td>
                          <td>
                            {rowError ? (
                              <span className="status-badge warning compact">
                                {rowError}
                              </span>
                            ) : (
                              <span
                                className={`status-badge compact ${
                                  item.key && existingSecrets.has(item.key)
                                    ? "neutral"
                                    : "positive"
                                }`}
                              >
                                {item.key && existingSecrets.has(item.key)
                                  ? "Update"
                                  : "New"}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {!hasBlockingErrors && validEntries.length > 0 && (
                <p className="section-description">
                  {createCount > 0 && `${createCount} to add`}
                  {createCount > 0 && updateCount > 0 && ", "}
                  {updateCount > 0 && `${updateCount} to update`}
                  {createCount === 0 && updateCount === 0 && "Nothing to apply"}
                </p>
              )}
            </div>
          )}

          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={submitting}
              onClick={onCancel}
            >
              Cancel
            </button>

            <button
              className="primary-button"
              type="submit"
              disabled={
                submitting || hasBlockingErrors || validEntries.length === 0
              }
            >
              {submitting
                ? "Applying..."
                : `Apply${validEntries.length > 0 ? ` (${validEntries.length})` : ""}`}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
