/**
 * Shown while a speed test is running on the connected Speedtest Tracker.
 *
 * The test happens on the other service and takes roughly a minute, so there
 * is no real progress to report — this is deliberately an *indeterminate*
 * bar rather than a fake percentage that would imply knowledge the panel
 * doesn't have. It reuses the deploy-progress stripe animation so
 * "something is happening" looks the same everywhere in the panel.
 */
export default function SpeedtestRunningBar() {
  return (
    <div className="speedtest-running" role="status" aria-live="polite">
      <div className="speedtest-running-head">
        <span className="speedtest-running-dot" aria-hidden="true" />
        <span>Running speed test…</span>
        <span className="text-faint speedtest-running-note">
          This takes about a minute — the reading updates automatically.
        </span>
      </div>
      <div
        className="speedtest-running-track"
        role="progressbar"
        aria-label="Speed test in progress"
      >
        <span className="speedtest-running-fill" />
      </div>
    </div>
  );
}
