import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiError, BuildLog, BuildLogResponse } from "../types/api";

interface DeploymentFailureModalProps {
  appId: number;
  appName: string;
  /** The short failure reason from the deployment progress stream. */
  reason: string | null;
  /** Whether the failed deployment rolled back to the previous version. */
  rolledBack: boolean;
  onClose: () => void;
  /** Navigates to the app's full Logs tab (optional convenience). */
  onOpenFullLogs?: () => void;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

/**
 * A modal that surfaces the full build output the instant a deployment fails,
 * so the failure can't scroll away or be lost behind a rollback. It shows the
 * complete stored build log (not a snippet), keeps a copy button for pasting
 * the errors elsewhere, and is deliberately its own window over the page.
 */
export default function DeploymentFailureModal({
  appId,
  appName,
  reason,
  rolledBack,
  onClose,
  onOpenFullLogs
}: DeploymentFailureModalProps) {
  const [buildLog, setBuildLog] = useState<BuildLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);

  const loadBuildLog = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");
      const response = await fetch(`/api/apps/${appId}/build-log`);
      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load the build log"));
      }
      const result = (await response.json()) as BuildLogResponse;
      setBuildLog(result.buildLog);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load the build log");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void loadBuildLog();
  }, [loadBuildLog]);

  const logText = buildLog?.log ?? "";
  const hasLog = logText.length > 0;

  // What Copy hands over: the full build output when there is one, otherwise
  // the failure reason — so the button is never a no-op the operator has to
  // work around by re-typing an error.
  const copyText = hasLog ? logText : (reason ?? "Deployment failed.");

  // The newest output is at the bottom, which is where a build failure's
  // actual error lives — land there rather than at the top boilerplate.
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre && hasLog) {
      pre.scrollTop = pre.scrollHeight;
    }
  }, [hasLog, logText]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setLoadError("Couldn't copy to the clipboard — select the text and copy it manually.");
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="form-modal deploy-failure-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="deploy-failure-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow danger">Deployment failed</p>
            <h2 id="deploy-failure-title">{appName} didn&apos;t deploy</h2>
          </div>
          <button className="close-button" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="form-modal-body">
          {reason && <div className="error-banner">{reason}</div>}
          {rolledBack && (
            <p className="text-faint deploy-failure-note">
              The previous version is still running — it was restored automatically.
            </p>
          )}

          <div className="deploy-failure-logs-head">
            <span className="deploy-failure-logs-label">Build output</span>
            <div className="deploy-failure-logs-actions">
              <button
                className="secondary-button compact"
                type="button"
                onClick={() => void copy()}
              >
                {copied ? "Copied!" : hasLog ? "Copy log" : "Copy error"}
              </button>
              {onOpenFullLogs && (
                <button className="secondary-button compact" type="button" onClick={onOpenFullLogs}>
                  Open Logs tab
                </button>
              )}
            </div>
          </div>

          {buildLog?.truncated && (
            <div className="warning-banner">
              The build output was large — showing the most recent portion.
            </div>
          )}
          {loadError && <div className="error-banner">{loadError}</div>}

          <div className="deploy-failure-console">
            {loading && !buildLog ? (
              <p className="logs-state">Loading build output…</p>
            ) : hasLog ? (
              <pre ref={preRef}>{logText}</pre>
            ) : (
              <p className="logs-state">
                No build output was captured for this failure. The deployment failed
                {reason ? " for the reason above" : ""} before, or outside of, the image build.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
