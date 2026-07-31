import { useState } from "react";

const DISMISS_KEY_PREFIX = "dp_dismissed_image_update_";

interface ImageUpdateBannerProps {
  appId: number;
  imageUpdateAvailable: boolean;
  imageUpdateCheckedAt: string | null;
}

/**
 * Dismissible banner shown above an app's action row when a background
 * check finds its registry image has moved past what's running. Dismissal
 * is per-check (keyed by imageUpdateCheckedAt in sessionStorage), so it
 * reappears if a further-newer image lands on a later check — same pattern
 * as the platform's own UpdateBanner/useUpdateAvailable.
 */
export default function ImageUpdateBanner({
  appId,
  imageUpdateAvailable,
  imageUpdateCheckedAt
}: ImageUpdateBannerProps) {
  const dismissKey = `${DISMISS_KEY_PREFIX}${appId}`;
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(dismissKey);
    } catch {
      return null;
    }
  });

  if (!imageUpdateAvailable || imageUpdateCheckedAt === dismissed) {
    return null;
  }

  const dismiss = () => {
    try {
      sessionStorage.setItem(dismissKey, imageUpdateCheckedAt ?? "");
    } catch {
      // Ignore storage failures — dismissal is best-effort.
    }
    setDismissed(imageUpdateCheckedAt);
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-dot" aria-hidden="true" />
      <span className="update-banner-text">
        A new image is available for this app — redeploy to update.
      </span>
      <button className="update-banner-dismiss" type="button" aria-label="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
