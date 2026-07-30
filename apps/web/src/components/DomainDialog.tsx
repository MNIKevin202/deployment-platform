import { useEffect, useState } from "react";
import { isValidCustomDomain } from "../lib/wizardValidation";
import type { UpdateAppRoutingPayload } from "../types/api";

interface DomainDialogProps {
  open: boolean;
  currentDomain: string | null;
  currentInternalOnly: boolean;
  submitting: boolean;
  error: string;
  onSubmit: (payload: UpdateAppRoutingPayload) => void;
  onCancel: () => void;
}

type RoutingChoice = "public" | "internal";
type DomainChoice = "default" | "custom";

export default function DomainDialog({
  open,
  currentDomain,
  currentInternalOnly,
  submitting,
  error,
  onSubmit,
  onCancel
}: DomainDialogProps) {
  const [routingChoice, setRoutingChoice] = useState<RoutingChoice>("public");
  const [domainChoice, setDomainChoice] = useState<DomainChoice>("default");
  const [customDomain, setCustomDomain] = useState("");

  useEffect(() => {
    if (open) {
      setRoutingChoice(currentInternalOnly ? "internal" : "public");
      setDomainChoice(currentDomain ? "custom" : "default");
      setCustomDomain(currentDomain ?? "");
    }
    // Only reset when the dialog opens, not on every prop identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) {
    return null;
  }

  const trimmedCustomDomain = customDomain.trim();
  const needsCustomDomain = routingChoice === "public" && domainChoice === "custom";
  const customDomainValid = !needsCustomDomain || isValidCustomDomain(trimmedCustomDomain);
  const canSubmit = customDomainValid && (!needsCustomDomain || trimmedCustomDomain.length > 0);

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
            <p className="eyebrow">Routing</p>
            <h2>Edit Domain</h2>
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

            if (!canSubmit) {
              return;
            }

            onSubmit({
              internalOnly: routingChoice === "internal",
              customDomain: needsCustomDomain ? trimmedCustomDomain : undefined
            });
          }}
        >
          {error && <div className="error-banner">{error}</div>}

          <fieldset className="wizard-fieldset">
            <legend>Routing</legend>

            <label className="radio-field">
              <input
                type="radio"
                name="edit-routing-choice"
                checked={routingChoice === "public"}
                disabled={submitting}
                onChange={() => setRoutingChoice("public")}
              />
              <span>
                <strong>Public app</strong> — reachable at a domain over HTTPS.
              </span>
            </label>
            <label className="radio-field">
              <input
                type="radio"
                name="edit-routing-choice"
                checked={routingChoice === "internal"}
                disabled={submitting}
                onChange={() => setRoutingChoice("internal")}
              />
              <span>
                <strong>Internal-only app</strong> — no public domain, no
                route, no TLS certificate. Reachable only from other apps on
                the platform's private network, by container name.
              </span>
            </label>
          </fieldset>

          {routingChoice === "public" && (
            <fieldset className="wizard-fieldset">
              <legend>Domain</legend>

              <label className="radio-field">
                <input
                  type="radio"
                  name="edit-domain-choice"
                  checked={domainChoice === "default"}
                  disabled={submitting}
                  onChange={() => setDomainChoice("default")}
                />
                <span>Use the platform's generated domain</span>
              </label>
              <label className="radio-field">
                <input
                  type="radio"
                  name="edit-domain-choice"
                  checked={domainChoice === "custom"}
                  disabled={submitting}
                  onChange={() => setDomainChoice("custom")}
                />
                <span>Use a custom domain</span>
              </label>

              {domainChoice === "custom" && (
                <label>
                  <span>Custom domain</span>
                  <input
                    type="text"
                    value={customDomain}
                    onChange={(event) => setCustomDomain(event.target.value)}
                    placeholder="roadmapstudio.xyz"
                    spellCheck={false}
                    autoCapitalize="off"
                    disabled={submitting}
                  />
                  {trimmedCustomDomain.length > 0 && !customDomainValid && (
                    <small className="text-faint">
                      Enter a plain hostname with no scheme, path, port, or
                      wildcard (e.g. roadmapstudio.xyz).
                    </small>
                  )}
                  <small className="text-faint">
                    DNS for this domain must already point (or be pointed) at
                    this server — the platform does not configure DNS
                    automatically.
                  </small>
                </label>
              )}
            </fieldset>
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
              disabled={submitting || !canSubmit}
            >
              {submitting ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
