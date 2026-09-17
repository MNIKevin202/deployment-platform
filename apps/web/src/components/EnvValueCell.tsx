import { useState } from "react";
import { looksSecret } from "../lib/envSecrets";

interface EnvValueCellProps {
  keyName: string;
  value: string | null;
  hasValue: boolean;
  /** The operator explicitly flagged this variable as secret. */
  isSecret: boolean;
}

/**
 * Renders a single environment-variable value: masked when it is (or looks
 * like) a secret, kept to one line when long, and revealed / expanded /
 * copied only on an explicit click.
 *
 * A flagged secret arrives without its value (`value === null`), so it can be
 * masked but never revealed here. A value that merely *looks* secret (see
 * `looksSecret`) still has its plaintext, so it is masked by default but can
 * be revealed — the value is never hidden from the operator who owns it.
 */
export default function EnvValueCell({
  keyName,
  value,
  hasValue,
  isSecret
}: EnvValueCellProps) {
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!hasValue) {
    const treatAsSecret = isSecret || looksSecret(keyName);
    return (
      <span className="text-faint">{treatAsSecret ? "Not set" : "Empty"}</span>
    );
  }

  const treatAsSecret = isSecret || looksSecret(keyName, value);
  // We can only reveal a value we actually received. Flagged secrets are
  // withheld by the API, so `value` is null and there is nothing to show.
  const revealable = value !== null && value !== "";

  const copy = async () => {
    if (value === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — nothing to do.
    }
  };

  if (treatAsSecret && !revealed) {
    return (
      <div className="env-value">
        <span className="masked-value">••••••••</span>
        {revealable && (
          <button
            type="button"
            className="env-value-action"
            onClick={() => setRevealed(true)}
          >
            Show
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="env-value">
      <code
        className={`env-value-text${expanded ? " expanded" : ""}`}
        title={expanded ? "Click to collapse" : "Click to expand"}
        onClick={() => setExpanded((previous) => !previous)}
      >
        {value}
      </code>
      <div className="env-value-actions">
        {treatAsSecret && (
          <button
            type="button"
            className="env-value-action"
            onClick={() => setRevealed(false)}
          >
            Hide
          </button>
        )}
        <button type="button" className="env-value-action" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
