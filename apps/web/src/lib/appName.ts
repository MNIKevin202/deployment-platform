/**
 * The platform names every managed container `app-<name>`, but the app's own
 * canonical name (StoredApp.name) has no prefix. Lists already say these are
 * apps, so the prefix is redundant noise — always prefer the canonical name,
 * and only strip the prefix when falling back to a container name (an orphan
 * container with no app record).
 *
 * Deliberately NOT applied to StoredApp.name itself: an app genuinely named
 * "app-foo" should keep its name intact.
 */
export function stripContainerPrefix(containerName: string): string {
  return containerName.replace(/^\//, "").replace(/^app-/, "");
}

/** The name to show for a row/card: the app's own name, else its container's (de-prefixed). */
export function displayAppName(
  appName: string | null | undefined,
  containerName?: string | null,
  fallback = ""
): string {
  if (appName) {
    return appName;
  }
  return containerName ? stripContainerPrefix(containerName) : fallback;
}
