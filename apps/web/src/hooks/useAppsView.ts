import { useCallback, useState } from "react";

export type AppsView = "grid" | "table";

const STORAGE_KEY = "dp_apps_view";

/** The Apps list layout preference, persisted in localStorage (per browser). */
export function useAppsView(): [AppsView, (view: AppsView) => void] {
  const [view, setViewState] = useState<AppsView>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "table" ? "table" : "grid";
    } catch {
      return "grid";
    }
  });

  const setView = useCallback((next: AppsView) => {
    setViewState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures — the preference just won't persist.
    }
  }, []);

  return [view, setView];
}
