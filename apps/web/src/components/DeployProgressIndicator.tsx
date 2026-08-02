import type { DeployProgress } from "../types/api";
import { formatDuration } from "./DeploymentProgressOverlay";

/**
 * A compact, animated "this app is deploying" bar for dense surfaces — a
 * table status cell or an app card. The percentage is the real measured
 * value (see deploy-progress-service); the moving stripes convey liveness
 * even when the percentage is briefly static, e.g. during a long build step.
 */
export function InlineDeployProgress({ progress }: { progress: DeployProgress }) {
  return (
    <div className="deploy-inline" role="status" aria-live="polite">
      <div className="deploy-inline-top">
        <span className="deploy-inline-dot" aria-hidden="true" />
        <span className="deploy-inline-label">Deploying</span>
        <span className="deploy-inline-percent">{progress.percent}%</span>
      </div>
      <div
        className="deploy-inline-bar"
        role="progressbar"
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Deploying ${progress.appName}, ${progress.percent}% complete`}
      >
        <div className="deploy-inline-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <span className="deploy-inline-stage text-faint">{progress.stageLabel}</span>
    </div>
  );
}

/**
 * The larger deploying banner for the app-detail page — the same live data
 * as the inline bar, with room for Docker's step counter and the time
 * estimate. Shown only while a deployment is in flight.
 */
export function DeployProgressBanner({ progress }: { progress: DeployProgress }) {
  return (
    <div className="deploy-banner" role="status" aria-live="polite">
      <div className="deploy-banner-head">
        <span className="deploy-banner-spinner" aria-hidden="true" />
        <div className="deploy-banner-heading">
          <strong>Deploying…</strong>
          {progress.source && (
            <span className="text-faint deploy-banner-source">{progress.source}</span>
          )}
        </div>
        <span className="deploy-banner-percent">{progress.percent}%</span>
      </div>

      <div
        className="deploy-banner-bar"
        role="progressbar"
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Deploying, ${progress.percent}% complete`}
      >
        <div className="deploy-banner-fill" style={{ width: `${progress.percent}%` }} />
      </div>

      <div className="deploy-banner-meta">
        <span className="text-faint">{progress.stageLabel}</span>
        {progress.step !== null && progress.totalSteps !== null && (
          <span className="text-faint">
            Step {progress.step}/{progress.totalSteps}
          </span>
        )}
        <span className="text-faint">
          {progress.etaSeconds !== null
            ? `~${formatDuration(progress.etaSeconds)} remaining`
            : "Estimating…"}
        </span>
      </div>
    </div>
  );
}
