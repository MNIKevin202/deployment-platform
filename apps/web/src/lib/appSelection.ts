import type { ContainerSummary, StoredApp } from "../types/api";

export function appSelectionKey(storedApp: StoredApp): string {
  return `app:${storedApp.id}`;
}

export function containerSelectionKey(
  container: ContainerSummary,
  storedApp?: StoredApp
): string {
  return storedApp ? appSelectionKey(storedApp) : `container:${container.id}`;
}
