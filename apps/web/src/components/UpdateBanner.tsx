import { useUpdateAvailable } from "../hooks/useUpdateAvailable";

/**
 * A slim, dismissible strip shown on every page when a newer version of the
 * platform UI has been deployed. Updating is optional — the current tab keeps
 * working — but reloading loads the new version.
 */
export default function UpdateBanner() {
  const { showBanner, dismiss } = useUpdateAvailable();

  if (!showBanner) {
    return null;
  }

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-dot" aria-hidden="true" />
      <span className="update-banner-text">A new version of the panel is available.</span>
      <button className="update-banner-reload" type="button" onClick={() => window.location.reload()}>
        Reload to update
      </button>
      <button className="update-banner-dismiss" type="button" aria-label="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
