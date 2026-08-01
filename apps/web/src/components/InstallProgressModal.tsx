import type { InstallProgress } from "../types/api";

interface InstallProgressModalProps {
  open: boolean;
  /** The app being installed, for the heading. */
  appName: string;
  /**
   * Live progress from the server, or null before the first event arrives —
   * the bar shows an honest 0% rather than inventing movement.
   */
  progress: InstallProgress | null;
  /** Set when the install failed; shown with the rollback outcome. */
  error: string;
  onClose: () => void;
}

/**
 * A live install progress dialog.
 *
 * The percentage is a real measurement, not an animation: it comes from
 * Docker's own per-layer download byte counts for the image pull (which
 * dominates install time) plus discrete stage weights for the steps that
 * have no sub-progress to report. When the server hasn't sent anything yet
 * the bar sits at 0 rather than drifting upward on a timer.
 */
export default function InstallProgressModal({
  open,
  appName,
  progress,
  error,
  onClose
}: InstallProgressModalProps) {
  if (!open) {
    return null;
  }

  const failed = progress?.status === "failed" || Boolean(error);
  const percent = failed ? (progress?.percent ?? 0) : (progress?.percent ?? 0);
  const multiService = (progress?.services.length ?? 0) > 1;

  const headline = failed
    ? "Installation failed"
    : progress?.status === "succeeded"
      ? "Installation complete"
      : progress?.currentService && multiService
        ? `Installing ${progress.currentService}…`
        : `Installing ${appName}…`;

  return (
    // No backdrop click handler: an install is in flight behind this, and a
    // stray click must not dismiss the only view of its progress.
    <div className="modal-backdrop">
      <section
        className="form-modal install-progress-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Installation progress"
      >
        <header>
          <div>
            <p className="eyebrow">Deploying</p>
            <h2>{headline}</h2>
          </div>
        </header>

        <div className="install-progress-body">
          <div
            className="install-progress-bar"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Installation ${percent}% complete`}
          >
            <div
              className={`install-progress-fill${failed ? " failed" : ""}${
                progress?.status === "succeeded" ? " complete" : ""
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>

          <p className="install-progress-percent">
            <strong>{percent}%</strong>
            {progress?.status === "running" && (
              <span className="text-faint">
                {" "}
                {progress.services.find(
                  (service) => service.name === progress.currentService
                )?.detail ?? "Starting…"}
              </span>
            )}
          </p>

          {multiService && progress && (
            <ul className="install-progress-services">
              {progress.services.map((service) => (
                <li key={service.name}>
                  <span className="install-progress-service-name">
                    <code>{service.name}</code>
                    {service.stage === "done" && (
                      <span className="status-badge positive compact">Done</span>
                    )}
                    {service.name === progress.currentService &&
                      progress.status === "running" && (
                        <span className="status-badge compact">In progress</span>
                      )}
                  </span>
                  <span className="text-faint">{service.detail}</span>
                  <span className="install-progress-service-bar">
                    <span
                      className={`install-progress-service-fill${failed ? " failed" : ""}`}
                      style={{ width: `${service.percent}%` }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}

          {failed ? (
            <div className="error-banner" role="alert">
              {error || progress?.error || "The installation failed."}
            </div>
          ) : progress?.status === "succeeded" ? (
            <p className="section-description">Everything is up and running.</p>
          ) : (
            <p className="section-description">
              Downloading and starting containers. Large images can take several minutes on a
              small server — leaving this page won't cancel the install.
            </p>
          )}
        </div>

        {/* Closing is only offered once nothing is in flight, so the dialog
            can't be dismissed into a state where progress is unobservable. */}
        {progress?.status !== "running" && (
          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
