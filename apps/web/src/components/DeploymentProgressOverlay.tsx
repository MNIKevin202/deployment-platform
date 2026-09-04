import { useCallback, useEffect, useRef, useState } from "react";
import type { DeployProgress } from "../types/api";
import DeploymentFailureModal from "./DeploymentFailureModal";

interface DeploymentProgressOverlayProps {
  /** Navigates to an app's detail page (used by the failure card). */
  onViewApp: (appId: number) => void;
}

/** The failing deployment currently shown in the failure modal, if any. */
interface FailureModalState {
  appId: number;
  appName: string;
  reason: string | null;
  rolledBack: boolean;
}

/**
 * A site-wide deployment progress overlay.
 *
 * Rendered once at the app shell level rather than inside any page, so a
 * deployment stays visible while the operator navigates around — the whole
 * point is being able to start a deploy and keep working without losing
 * sight of it.
 *
 * The percentage is a real measurement, not an animation: stage
 * transitions give a floor, and inside the build (by far the longest part)
 * Docker's own "Step X/Y" counter drives it. The time estimate is
 * extrapolated from elapsed time and withheld entirely until it means
 * something, rather than shown as a confident guess.
 *
 * A failed deployment is *sticky*: it stays on screen with its reason
 * until dismissed, because a failure that scrolls away unnoticed is the
 * exact problem this overlay exists to solve.
 */
export default function DeploymentProgressOverlay({
  onViewApp
}: DeploymentProgressOverlayProps) {
  const [deployments, setDeployments] = useState<DeployProgress[]>([]);
  const [failureModal, setFailureModal] = useState<FailureModalState | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  // Which failures have already auto-opened the modal, so a repeated SSE frame
  // for the same failed run can't reopen it after the operator closed it. Keyed
  // by appId + finish time, so a genuinely new failure of the same app opens
  // fresh. A snapshot on (re)connect is NOT auto-surfaced — only a live
  // transition to failed is — so reconnecting doesn't resurface an old failure.
  const surfacedFailures = useRef<Set<string>>(new Set());

  const failureKey = (deployment: DeployProgress): string =>
    `${deployment.appId}:${deployment.finishedAt ?? ""}`;

  const maybeSurfaceFailure = useCallback((deployment: DeployProgress) => {
    if (deployment.status !== "failed") {
      return;
    }
    const key = failureKey(deployment);
    if (surfacedFailures.current.has(key)) {
      return;
    }
    surfacedFailures.current.add(key);
    setFailureModal({
      appId: deployment.appId,
      appName: deployment.appName,
      reason: deployment.error,
      rolledBack: deployment.rolledBack
    });
  }, []);

  // A failure that arrives in a snapshot (a page load or an EventSource
  // reconnect that lands AFTER the deploy already failed) is surfaced too, as
  // long as it finished recently — so opening the panel right after a failure
  // still pops the modal, without resurfacing a stale failure from long ago.
  const RECENT_FAILURE_MS = 5 * 60_000;
  const maybeSurfaceRecentFailure = useCallback(
    (deployment: DeployProgress) => {
      if (deployment.status !== "failed" || !deployment.finishedAt) {
        return;
      }
      const finishedMs = new Date(deployment.finishedAt).getTime();
      if (Number.isNaN(finishedMs) || Date.now() - finishedMs > RECENT_FAILURE_MS) {
        return;
      }
      maybeSurfaceFailure(deployment);
    },
    [maybeSurfaceFailure]
  );

  const upsert = useCallback((next: DeployProgress) => {
    setDeployments((current) => {
      const index = current.findIndex((item) => item.appId === next.appId);

      if (index === -1) {
        return [next, ...current];
      }

      const copy = [...current];
      copy[index] = next;
      return copy;
    });
  }, []);

  useEffect(() => {
    // Non-fatal by design: without EventSource (or if the stream can't be
    // opened) the panel simply shows no overlay — deployments themselves
    // are entirely unaffected.
    let source: EventSource;
    try {
      source = new EventSource("/api/deployments/progress");
    } catch {
      return;
    }

    sourceRef.current = source;

    source.addEventListener("snapshot", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          deployments: DeployProgress[];
        };
        const deployments = data.deployments ?? [];
        setDeployments(deployments);
        for (const deployment of deployments) {
          maybeSurfaceRecentFailure(deployment);
        }
      } catch {
        // A malformed frame is skipped rather than breaking the overlay.
      }
    });

    source.addEventListener("progress", (event) => {
      try {
        const deployment = JSON.parse((event as MessageEvent).data) as DeployProgress;
        upsert(deployment);
        // A live transition to "failed" pops the failure modal so the build
        // output is seen immediately, not hunted for after a rollback.
        maybeSurfaceFailure(deployment);
      } catch {
        // As above.
      }
    });

    // The browser reconnects EventSource on its own; a transient drop is
    // not a deployment failure and must not be reported as one.
    source.addEventListener("error", () => {});

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [upsert, maybeSurfaceFailure, maybeSurfaceRecentFailure]);

  const dismiss = async (appId: number) => {
    setDeployments((current) => current.filter((item) => item.appId !== appId));

    try {
      await fetch(`/api/deployments/progress/${appId}`, { method: "DELETE" });
    } catch {
      // The card is already gone locally; a failed dismiss just means the
      // server expires it on its own schedule.
    }
  };

  return (
    <>
      {deployments.length > 0 && (
        <div className="deploy-overlay" role="status" aria-live="polite">
          {deployments.map((deployment) => (
            <DeploymentCard
              key={deployment.appId}
              deployment={deployment}
              onDismiss={() => void dismiss(deployment.appId)}
              onViewApp={() => {
                void dismiss(deployment.appId);
                onViewApp(deployment.appId);
              }}
              onViewFailure={() =>
                setFailureModal({
                  appId: deployment.appId,
                  appName: deployment.appName,
                  reason: deployment.error,
                  rolledBack: deployment.rolledBack
                })
              }
            />
          ))}
        </div>
      )}

      {failureModal && (
        <DeploymentFailureModal
          appId={failureModal.appId}
          appName={failureModal.appName}
          reason={failureModal.reason}
          rolledBack={failureModal.rolledBack}
          onClose={() => setFailureModal(null)}
          onOpenFullLogs={() => {
            const { appId } = failureModal;
            setFailureModal(null);
            void dismiss(appId);
            onViewApp(appId);
          }}
        />
      )}
    </>
  );
}

/** "2m 30s", "45s" — compact enough for a corner card. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);

  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

interface DeploymentCardProps {
  deployment: DeployProgress;
  onDismiss: () => void;
  onViewApp: () => void;
  onViewFailure: () => void;
}

function DeploymentCard({ deployment, onDismiss, onViewApp, onViewFailure }: DeploymentCardProps) {
  const failed = deployment.status === "failed";
  const succeeded = deployment.status === "succeeded";

  return (
    <section
      className={`deploy-overlay-card${failed ? " failed" : ""}${succeeded ? " complete" : ""}`}
    >
      <header className="deploy-overlay-head">
        <div className="deploy-overlay-title">
          <strong>{deployment.appName}</strong>
          {deployment.source && (
            <span className="text-faint deploy-overlay-source">{deployment.source}</span>
          )}
        </div>
        {deployment.status !== "running" && (
          <button
            type="button"
            className="deploy-overlay-dismiss"
            onClick={onDismiss}
            aria-label={`Dismiss ${deployment.appName} deployment`}
          >
            ×
          </button>
        )}
      </header>

      <div
        className="deploy-overlay-bar"
        role="progressbar"
        aria-valuenow={deployment.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${deployment.appName} deployment ${deployment.percent}% complete`}
      >
        <div
          className={`deploy-overlay-fill${failed ? " failed" : ""}${succeeded ? " complete" : ""}`}
          style={{ width: `${deployment.percent}%` }}
        />
      </div>

      <div className="deploy-overlay-meta">
        <span className="deploy-overlay-percent">{deployment.percent}%</span>
        <span className="text-faint">
          {failed ? `Failed at: ${deployment.stageLabel}` : deployment.stageLabel}
        </span>
      </div>

      {deployment.status === "running" && (
        <div className="deploy-overlay-meta">
          {deployment.step !== null && deployment.totalSteps !== null && (
            <span className="text-faint">
              Step {deployment.step}/{deployment.totalSteps}
            </span>
          )}
          <span className="text-faint">
            {deployment.etaSeconds !== null
              ? `~${formatDuration(deployment.etaSeconds)} remaining`
              : "Estimating…"}
          </span>
        </div>
      )}

      {failed && (
        <>
          <p className="deploy-overlay-error">{deployment.error}</p>
          {deployment.rolledBack && (
            <p className="text-faint deploy-overlay-note">
              The previous version was restored.
            </p>
          )}
          <div className="deploy-overlay-actions">
            <button type="button" className="primary-button compact" onClick={onViewFailure}>
              View build log
            </button>
            <button type="button" className="secondary-button compact" onClick={onViewApp}>
              Open app
            </button>
          </div>
        </>
      )}
    </section>
  );
}
