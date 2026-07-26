import { randomBytes } from "node:crypto";
import type Docker from "dockerode";
import type { AppDatabase } from "../database.js";
import { buildContainerEnvArray } from "./environment-service.js";
import { buildVolumeMounts } from "./storage-service.js";
import { getErrorStatusCode } from "../docker-errors.js";
import type { RecordEventFn } from "./deployment-event-service.js";

const PROTECTED_CONTAINER_NAMES = new Set([
  "deployment-platform-api",
  "deployment-platform-web"
]);

type ContainerCreateOptions = Parameters<Docker["createContainer"]>[0];

export interface RedeployResult {
  success: boolean;
  message: string;
  containerId?: string;
}

export interface ContainerInspectResult {
  id: string;
  running: boolean;
  status: string;
}

/**
 * The narrow slice of Docker operations a redeploy actually needs. Keeping
 * this separate from the dockerode client itself means redeployApp's
 * orchestration logic can be unit tested with a plain fake, with no
 * dependency on the real Docker API surface.
 */
export interface RedeployDockerOps {
  pullImage(image: string): Promise<void>;
  createContainer(options: ContainerCreateOptions): Promise<{ id: string }>;
  startContainer(id: string): Promise<void>;
  inspectContainer(id: string): Promise<ContainerInspectResult>;
  /** Resolves even if the container is already gone (idempotent). */
  removeContainer(nameOrId: string): Promise<void>;
  renameContainer(id: string, newName: string): Promise<void>;
  /**
   * Creates the named volume, labeled for this app, if it doesn't exist
   * yet. If it already exists, throws unless it's already labeled as owned
   * by this same app — never silently reuses an unmanaged or
   * differently-owned volume.
   */
  ensureVolume(name: string, ownerAppName: string): Promise<void>;
}

export function createDockerOps(docker: Docker): RedeployDockerOps {
  return {
    async pullImage(image) {
      const stream = await docker.pull(image);

      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },

    async createContainer(options) {
      const container = await docker.createContainer(options);
      return { id: container.id };
    },

    async startContainer(id) {
      await docker.getContainer(id).start();
    },

    async inspectContainer(id) {
      const details = await docker.getContainer(id).inspect();

      return {
        id: details.Id,
        running: details.State.Running,
        status: details.State.Status
      };
    },

    async removeContainer(nameOrId) {
      try {
        await docker.getContainer(nameOrId).remove({ force: true });
      } catch (error) {
        if (getErrorStatusCode(error) !== 404) {
          throw error;
        }
      }
    },

    async renameContainer(id, newName) {
      await docker.getContainer(id).rename({ name: newName });
    },

    async ensureVolume(name, ownerAppName) {
      let existing: { Labels?: Record<string, string> | null } | null = null;

      try {
        existing = await docker.getVolume(name).inspect();
      } catch (error) {
        if (getErrorStatusCode(error) !== 404) {
          throw error;
        }
      }

      if (existing) {
        const owner = existing.Labels?.["com.deployment-platform.app-name"];

        if (owner !== ownerAppName) {
          throw new Error(
            `Docker volume "${name}" already exists and is not owned by this app`
          );
        }

        return;
      }

      await docker.createVolume({
        Name: name,
        Labels: {
          "com.deployment-platform.managed": "true",
          "com.deployment-platform.app-name": ownerAppName
        }
      });
    }
  };
}

export interface RedeployReconcileResult {
  lastReconcileSucceeded: boolean | null;
  lastError: string | null;
}

export interface RedeployDependencies {
  appDatabase: AppDatabase;
  dockerOps: RedeployDockerOps;
  reconcileRouting: (
    appDatabase: AppDatabase
  ) => Promise<RedeployReconcileResult>;
  recordEvent: RecordEventFn;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Safely recreates a managed app's container with its current effective
 * environment (global + app-specific variables), preserving image, port,
 * restart policy, domain, and container name.
 *
 * Strategy: build and start the replacement under a temporary name first,
 * and only remove the existing container once the replacement is confirmed
 * running. This means a failure while building/starting the replacement
 * never touches the working container — the only genuinely risky window is
 * the brief gap between removing the old container and renaming the new
 * one into its place, since Docker requires the name to be free before the
 * rename can succeed.
 */
export async function redeployApp(
  deps: RedeployDependencies,
  appId: number
): Promise<RedeployResult> {
  const { appDatabase, dockerOps, reconcileRouting, recordEvent } = deps;

  const app = appDatabase.getAppById(appId);

  if (!app) {
    return { success: false, message: "App not found" };
  }

  if (!app.containerName || PROTECTED_CONTAINER_NAMES.has(app.containerName)) {
    return {
      success: false,
      message: "This app cannot be redeployed"
    };
  }

  const containerName = app.containerName;
  const exposedPort = `${app.containerPort}/tcp`;
  const tempContainerName = `${containerName}-redeploy-${randomBytes(4).toString("hex")}`;

  recordEvent({
    appId: app.id,
    eventType: "redeploy-started",
    severity: "info",
    message: `Redeploy started for "${app.name}"`,
    metadata: { image: app.image }
  });

  try {
    await dockerOps.pullImage(app.image);
  } catch (error) {
    const message = `Unable to pull image "${app.image}": ${errorMessage(error)}`;

    recordEvent({
      appId: app.id,
      eventType: "redeploy-failed",
      severity: "error",
      message
    });

    return { success: false, message };
  }

  const volumes = appDatabase.listAppVolumes(app.id);

  try {
    for (const volume of volumes) {
      await dockerOps.ensureVolume(volume.volumeName, app.name);
    }
  } catch (error) {
    const message = `Unable to prepare storage for this app: ${errorMessage(error)}. The existing app was not affected.`;

    recordEvent({
      appId: app.id,
      eventType: "redeploy-failed",
      severity: "error",
      message
    });

    return { success: false, message };
  }

  const envArray = buildContainerEnvArray(
    appDatabase.listGlobalEnvVars(),
    appDatabase.listAppEnvVars(app.id)
  );

  let newContainerId: string | null = null;
  let lastKnownStatus = "unknown";

  try {
    const created = await dockerOps.createContainer({
      name: tempContainerName,
      Image: app.image,
      Env: envArray,
      Labels: {
        "com.deployment-platform.managed": "true",
        "com.deployment-platform.app-name": app.name
      },
      ExposedPorts: {
        [exposedPort]: {}
      },
      HostConfig: {
        NetworkMode: "deployment-apps",
        RestartPolicy: {
          Name: app.restartPolicy || "unless-stopped"
        },
        Mounts: buildVolumeMounts(volumes)
      }
    });

    newContainerId = created.id;

    await dockerOps.startContainer(newContainerId);

    const inspected = await dockerOps.inspectContainer(newContainerId);
    lastKnownStatus = inspected.status;

    if (!inspected.running) {
      throw new Error(
        `New container failed to reach a running state (status: ${inspected.status})`
      );
    }
  } catch (error) {
    // Nothing about the working container has changed yet — clean up the
    // failed replacement and leave the original container exactly as it
    // was.
    if (newContainerId) {
      await dockerOps.removeContainer(newContainerId).catch(() => undefined);
    } else {
      await dockerOps.removeContainer(tempContainerName).catch(() => undefined);
    }

    const message = `Redeploy failed while starting the new container: ${errorMessage(error)}. The existing app was not affected.`;

    recordEvent({
      appId: app.id,
      eventType: "redeploy-failed",
      severity: "error",
      message
    });

    return { success: false, message };
  }

  // From here on, newContainerId is guaranteed non-null (the block above
  // either sets it and continues, or returns early).
  const confirmedNewContainerId = newContainerId;

  try {
    await dockerOps.removeContainer(containerName);
  } catch (error) {
    // The working app is untouched, but the replacement we just started is
    // now pointless — try to remove it rather than leaving it running
    // indefinitely. If that also fails, surface only the container ID
    // (never image, env, or other config) so an operator can find it.
    try {
      await dockerOps.removeContainer(confirmedNewContainerId);

      const message =
        `The previous container could not be removed (${errorMessage(error)}), ` +
        `so the redeploy was cancelled and the existing app was left running. ` +
        `The unused replacement container was cleaned up automatically.`;

      recordEvent({
        appId: app.id,
        eventType: "redeploy-failed",
        severity: "error",
        message
      });

      return { success: false, message };
    } catch (cleanupError) {
      const message =
        `The previous container could not be removed (${errorMessage(error)}), ` +
        `so the redeploy was cancelled and the existing app was left running. ` +
        `The unused replacement container (id ${confirmedNewContainerId}) could ` +
        `not be cleaned up automatically (${errorMessage(cleanupError)}) — ` +
        `remove it manually.`;

      recordEvent({
        appId: app.id,
        eventType: "redeploy-failed",
        severity: "error",
        message,
        metadata: { leftoverContainerId: confirmedNewContainerId }
      });

      return { success: false, message };
    }
  }

  // Destructive boundary crossed: the previous container is gone. Every
  // remaining step must be defensive — nothing past this point may throw
  // uncaught, and the database must end up pointing at whatever container
  // actually exists rather than the one we just deleted.
  try {
    await dockerOps.renameContainer(confirmedNewContainerId, containerName);
  } catch (error) {
    const message =
      `The previous container was removed, but the replacement could not ` +
      `be renamed to "${containerName}" (${errorMessage(error)}). The app ` +
      `is currently down. The replacement container (id ` +
      `${confirmedNewContainerId}) is still running under a temporary name ` +
      `— check Docker manually. The database was not updated, so retrying ` +
      `redeploy may resolve this once no container is named ` +
      `"${containerName}".`;

    recordEvent({
      appId: app.id,
      eventType: "redeploy-failed",
      severity: "error",
      message,
      metadata: { leftoverContainerId: confirmedNewContainerId }
    });

    return { success: false, message };
  }

  // The rename succeeded, so the replacement is confirmed to be the app's
  // container now. A failure to re-inspect it is very likely transient —
  // fall back to the last status we know is good rather than leaving the
  // database pointing at the container we just removed.
  let finalContainerId = confirmedNewContainerId;
  let finalStatus = lastKnownStatus;
  let statusWarning: string | null = null;

  try {
    const finalDetails = await dockerOps.inspectContainer(confirmedNewContainerId);
    finalContainerId = finalDetails.id;
    finalStatus = finalDetails.status;
  } catch (error) {
    statusWarning = `a post-deploy status check failed (${errorMessage(error)}); the recorded status may be stale`;
  }

  try {
    appDatabase.updateAppContainer(app.id, {
      containerId: finalContainerId,
      status: finalStatus
    });
  } catch (error) {
    // Docker is actually fine at this point (the replacement is running as
    // the app's canonical container) — it's specifically the database write
    // that failed, so say so precisely rather than claiming success.
    const message =
      `The replacement container (id ${finalContainerId}) is running as ` +
      `"${containerName}", but the database could not be updated ` +
      `(${errorMessage(error)}). The dashboard may show stale information ` +
      `until this is resolved — retrying redeploy should recover cleanly.`;

    recordEvent({
      appId: app.id,
      eventType: "redeploy-failed",
      severity: "error",
      message,
      metadata: { newContainerId: finalContainerId }
    });

    return { success: false, message, containerId: finalContainerId };
  }

  let routingWarning: string | null = null;

  try {
    const routingStatus = await reconcileRouting(appDatabase);

    if (routingStatus.lastReconcileSucceeded === false) {
      routingWarning = `routing could not be updated: ${routingStatus.lastError ?? "unknown error"}`;
    }
  } catch (error) {
    routingWarning = `routing reconciliation failed: ${errorMessage(error)}`;
  }

  const warnings = [statusWarning, routingWarning].filter(
    (warning): warning is string => warning !== null
  );

  recordEvent({
    appId: app.id,
    eventType: "redeploy-succeeded",
    severity: "info",
    message: `Redeploy succeeded for "${app.name}"`,
    metadata: { newContainerId: finalContainerId, image: app.image }
  });

  if (routingWarning) {
    recordEvent({
      appId: app.id,
      eventType: "routing-warning",
      severity: "warning",
      message: `Routing warning after redeploying "${app.name}": ${routingWarning}`
    });
  }

  return {
    success: true,
    message:
      warnings.length > 0
        ? `App redeployed successfully, but ${warnings.join("; and ")}.`
        : "App redeployed successfully.",
    containerId: finalContainerId
  };
}
