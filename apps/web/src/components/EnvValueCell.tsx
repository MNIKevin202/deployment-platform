import { useState } from "react";
import { looksSecret } from "../lib/envSecrets";

interface EnvValueCellProps {
  keyName: string;
  value: string | null;
  hasValue: boolean;
  /** The operator explicitly flagged this variable as secret. */
  isSecret: boolean;
  /**
   * Fetches this variable's plaintext on demand. Provided for flagged secrets,
   * whose value the API withholds from list responses (`value === null`) and
   * returns only from a dedicated, admin-gated reveal endpoint. When absent, a
   * withheld secret stays unrevealable (there is nothing to show).
   */
  onReveal?: () => Promise<string>;
}

/**
 * Renders a single environment-variable value: masked when it is (or looks
 * like) a secret, kept to one line when long, and revealed / expanded /
 * copied only on an explicit click.
 *
 * A flagged secret arrives without its value (`value === null`). If an
 * `onReveal` fetcher is provided, clicking "Show" fetches the plaintext from
 * the reveal endpoint on demand; otherwise it stays masked with nothing to
 * reveal. A value that merely *looks* secret (see `looksSecret`) already has
 * its plaintext, so it is masked by default but revealed locally.
 */
export default function EnvValueCell({
  keyName,
  value,
  hasValue,
  isSecret,
  onReveal
}: EnvValueCellProps) {
  const [revealed, setRevealed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  // Plaintext fetched on demand for a withheld secret.
  const [fetchedValue, setFetchedValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  if (!hasValue) {
    const treatAsSecret = isSecret || looksSecret(keyName);
    return (
      <span className="text-faint">{treatAsSecret ? "Not set" : "Empty"}</span>
    );
  }

  // The value we can actually display: whatever the API sent, or what we
  // fetched on demand via onReveal.
  const shown = value ?? fetchedValue;
  const treatAsSecret = isSecret || looksSecret(keyName, shown);
  // Revealable if we already hold the plaintext, or can fetch it on demand.
  const revealable = (shown !== null && shown !== "") || (onReveal != null && hasValue);

  const show = async () => {
    setError(false);
    if (value !== null || fetchedValue !== null) {
      setRevealed(true);
      return;
    }
    if (!onReveal) {
      return;
    }
    setLoading(true);
    try {
      const plaintext = await onReveal();
      setFetchedValue(plaintext);
      setRevealed(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (shown === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(shown);
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
            onClick={() => void show()}
            disabled={loading}
          >
            {loading ? "Showing…" : "Show"}
          </button>
        )}
        {error && <span className="text-faint">Could not reveal</span>}
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
        {shown}
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
