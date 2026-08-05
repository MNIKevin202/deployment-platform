import { useCallback, useState } from "react";

const STORAGE_KEY = "dp_favorite_apps";

function readStoredFavorites(): Set<number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((value): value is number => typeof value === "number"));
  } catch {
    return new Set();
  }
}

function writeStoredFavorites(favorites: Set<number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(favorites)));
  } catch {
    // Ignore storage failures — the preference just won't persist.
  }
}

/** Which apps are pinned to the top of the Apps list, persisted per browser in localStorage. */
export function useFavoriteApps(): [Set<number>, (appId: number) => void] {
  const [favorites, setFavorites] = useState<Set<number>>(() => readStoredFavorites());

  const toggleFavorite = useCallback((appId: number) => {
    setFavorites((previous) => {
      const next = new Set(previous);
      if (next.has(appId)) {
        next.delete(appId);
      } else {
        next.add(appId);
      }
      writeStoredFavorites(next);
      return next;
    });
  }, []);

  return [favorites, toggleFavorite];
}
