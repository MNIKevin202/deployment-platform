import { useState } from "react";

interface CopyButtonProps {
  value: string;
  /** Used in the accessible name/tooltip, e.g. "image name" -> "Copy image name". */
  label: string;
}

/**
 * A small copy-to-clipboard affordance. Clipboard access can be denied (an
 * insecure origin, or a browser permission prompt), so a failure is silently
 * ignored rather than surfaced — copying is a convenience, never the only way
 * to get at a value.
 */
export default function CopyButton({ value, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="copy-button"
      aria-label={`Copy ${label}`}
      title={copied ? "Copied!" : `Copy ${label}`}
      onClick={async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable/denied — nothing useful to say here.
        }
      }}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}
