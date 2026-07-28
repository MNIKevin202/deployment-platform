/**
 * Live runtime state for a managed app, derived from Docker rather than the
 * stored `status` column. `present: false` means the app's database record
 * exists but its Docker container is gone (a crashed, rolled-back, or
 * externally-removed runtime) — such an app must stay listed, but must never
 * be shown as "running" just because a stale database row says so.
 */
export interface AppRuntimeState {
  present: boolean;
  running: boolean;
  status: string | null;
}

/** The narrow shape of a `docker.listContainers` entry this module reads. */
export interface ManagedContainerListItem {
  names: string[];
  state: string | null;
  labels: Record<string, string> | undefined;
}

const MANAGED_LABEL = "com.deployment-platform.managed";

/**
 * Builds a map of managed container name -> live state from a single
 * container listing, so the Apps endpoint can enrich every app from ONE
 * Docker call rather than one inspect per app. Only platform-managed
 * containers are included; unmanaged containers are irrelevant to app
 * runtime state.
 */
export function buildManagedContainerRuntimeMap(
  containers: ManagedContainerListItem[]
): Map<string, AppRuntimeState> {
  const byName = new Map<string, AppRuntimeState>();

  for (const container of containers) {
    if (container.labels?.[MANAGED_LABEL] !== "true") {
      continue;
    }

    const running = container.state === "running";
    for (const rawName of container.names) {
      const name = rawName.replace(/^\//, "");
      byName.set(name, { present: true, running, status: container.state });
    }
  }

  return byName;
}

/**
 * Resolves one app's runtime state against the map. A `null` map means
 * Docker could not be queried at all — the caller should fall back to the
 * stored status rather than wrongly declaring the container missing. A
 * container name not in the map means the record exists but the container
 * is gone: present=false, never "running".
 */
export function resolveAppRuntime(
  containerName: string | null,
  runtimeByName: Map<string, AppRuntimeState> | null
): AppRuntimeState | null {
  if (runtimeByName === null) {
    return null;
  }

  if (containerName) {
    const found = runtimeByName.get(containerName);
    if (found) {
      return found;
    }
  }

  return { present: false, running: false, status: null };
}
