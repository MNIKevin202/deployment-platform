import type Docker from "dockerode";
import type { AppDatabase, StoredApp } from "../database.js";
import { getErrorStatusCode } from "../docker-errors.js";

export interface ManagedContainerFound {
  found: true;
  app: StoredApp;
  containerExists: boolean;
  running: boolean;
  containerId: string | null;
}

export interface ManagedContainerNotFound {
  found: false;
}

export type ManagedContainerLookup = ManagedContainerFound | ManagedContainerNotFound;

/**
 * The single place that turns "an app id from the URL" into "the real
 * Docker container for that app, if any" — every route that needs to
 * inspect, fetch stats for, or read logs from a managed app's container
 * goes through this instead of accepting a container id from the browser.
 * The container is always looked up by the name stored on the app record,
 * so this can never resolve to a platform-owned or unrelated container.
 */
export async function resolveManagedContainer(
  appDatabase: Pick<AppDatabase, "getAppById">,
  docker: Docker,
  appId: number
): Promise<ManagedContainerLookup> {
  const app = appDatabase.getAppById(appId);

  if (!app) {
    return { found: false };
  }

  if (!app.containerName) {
    return { found: true, app, containerExists: false, running: false, containerId: null };
  }

  try {
    const details = await docker.getContainer(app.containerName).inspect();

    return {
      found: true,
      app,
      containerExists: true,
      running: details.State.Running,
      containerId: details.Id
    };
  } catch (error) {
    if (getErrorStatusCode(error) === 404) {
      return { found: true, app, containerExists: false, running: false, containerId: null };
    }

    throw error;
  }
}
