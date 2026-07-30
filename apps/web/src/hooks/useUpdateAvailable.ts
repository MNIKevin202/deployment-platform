import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, type UpdateStatus } from "../lib/updateCheck";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const DISMISS_KEY = "dp_dismissed_update";

/**
 * Polls for a newer deployed bundle (on mount, on an interval, and when the
 * tab regains focus) and tracks a per-version dismissal so a dismissed banner
 * reappears only when a still-newer version ships.
 */
export function useUpdateAvailable() {
  const [status, setStatus] = useState<UpdateStatus>({ running: null, served: null, updateAvailable: false });
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  const checkNow = useCallback(async (): Promise<UpdateStatus> => {
    try {
      const next = await checkForUpdate();
      setStatus(next);
      return next;
    } catch {
      return { running: null, served: null, updateAvailable: false };
    }
  }, []);

  useEffect(() => {
    void checkNow();
    const interval = window.setInterval(() => void checkNow(), POLL_INTERVAL_MS);
    const onFocus = () => void checkNow();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkNow]);

  const dismiss = useCallback(() => {
    if (status.served) {
      try {
        sessionStorage.setItem(DISMISS_KEY, status.served);
      } catch {
        // Ignore storage failures — dismissal is best-effort.
      }
      setDismissed(status.served);
    }
  }, [status.served]);

  const showBanner = status.updateAvailable && status.served !== dismissed;

  return { status, showBanner, checkNow, dismiss };
}
