import type Docker from "dockerode";
import type { AppDatabase } from "../database.js";
import type { RedeployReconcileResult } from "./redeploy-service.js";
import { getErrorStatusCode } from "../docker-errors.js";
import {
  APP_DELETION_IDEMPOTENCY_SCOPE,
  fingerprintDeleteAppRequest
} from "./idempotency.js";

const PROTECTED_CONTAINER_NAMES = new Set([
  "deployment-platform-api",
  "deployment-platform-web"
]);

export interface ContainerProtectionInfo {
  name: string;
  labels: Record<string, string>;
  isSystemContainer: boolean;
  isManagedApp: boolean;
}

/**
 * The narrow slice of Docker operations app deletion needs, mirroring
 * RedeployDockerOps — kept separate from the dockerode client so the
 * orchestration below is unit-testable with a plain fake.
 */
export interface DeletionDockerOps {
  /** Throws a dockerode-shaped error with statusCode 404 if not found. */
  inspectForDeletion(id: string): Promise<ContainerProtectionInfo>;
  removeContainer(id: string): Promise<void>;
}

export function createDeletionDockerOps(docker: Docker): DeletionDockerOps {
  return {
    async inspectForDeletion(id) {
      const container = docker.getContainer(id);
      const details = await container.inspect();
      const name = details.Name.replace(/^\//, "");
      const labels = details.Config.Labels ?? {};

      return {
        name,
        labels,
        isSystemContainer:
          PROTECTED_CONTAINER_NAMES.has(name) ||
          labels["com.deployment-platform.system"] === "true",
        isManagedApp: labels["com.deployment-platform.managed"] === "true"
      };
    },

    async removeContainer(id) {
      await docker.getContainer(id).remove({ force: true, v: true });
    }
  };
}

export interface DeleteAppServiceDependencies {
  appDatabase: AppDatabase;
  dockerOps: DeletionDockerOps;
  reconcileRouting: (
    appDatabase: AppDatabase
  ) => Promise<RedeployReconcileResult>;
}

export interface DeleteAppServiceResult {
  success: boolean;
  statusCode?: number;
  message: string;
  action?: "deleted";
  containerId?: string;
  name?: string;
  appName?: string | null;
}

/**
 * The single authoritative "delete a managed app" implementation — the exact
 * logic the DELETE /apps/:id route used to run inline. Split out so it can be
 * unit tested with fakes and, below, wrapped with idempotency-key handling.
 */
async function performDeleteApp(
  deps: DeleteAppServiceDependencies,
  containerId: string
): Promise<DeleteAppServiceResult> {
  const { appDatabase, dockerOps, reconcileRouting } = deps;

  let protection: ContainerProtectionInfo;
  try {
    protection = await dockerOps.inspectForDeletion(containerId);
  } catch (error) {
    return {
      success: false,
      statusCode: getErrorStatusCode(error) ?? 500,
      message: "Unable to delete app"
    };
  }

  if (protection.isSystemContainer) {
    return {
      success: false,
      statusCode: 403,
      message: "System containers cannot be deleted"
    };
  }

  if (!protection.isManagedApp) {
    return {
      success: false,
      statusCode: 403,
      message: "Only apps created by Deployment Platform can be deleted here"
    };
  }

  const appName = protection.labels["com.deployment-platform.app-name"];

  try {
    await dockerOps.removeContainer(containerId);
  } catch (error) {
    return {
      success: false,
      statusCode: getErrorStatusCode(error) ?? 500,
      message: "Unable to delete app"
    };
  }

  if (appName) {
    const storedApp = appDatabase.getAppByName(appName);

    if (storedApp) {
      appDatabase.deleteApp(storedApp.id);

      if (storedApp.domain) {
        await reconcileRouting(appDatabase);
      }
    }
  }

  return {
    success: true,
    message: `${protection.name} was deleted.`,
    action: "deleted",
    containerId,
    name: protection.name,
    appName: appName ?? null
  };
}

/**
 * Recovery-oriented deletion keyed by the app's own database id rather than a
 * live container id. This is the path the Apps page / detail use for an app
 * whose container has gone MISSING — the container-id path (above) can't be
 * used because there is no container to inspect. It removes the container by
 * the app's stored name if one still happens to exist (tolerating a 404 for
 * an already-gone runtime), then deletes the database record and reconciles
 * routing. Deliberately never fabricates a container id and never treats an
 * already-missing container as an error.
 */
export async function deleteManagedAppByAppId(
  deps: DeleteAppServiceDependencies,
  appId: number
): Promise<DeleteAppServiceResult> {
  const { appDatabase, dockerOps, reconcileRouting } = deps;

  const storedApp = appDatabase.getAppById(appId);
  if (!storedApp) {
    return { success: false, statusCode: 404, message: "App not found" };
  }

  if (
    storedApp.containerName &&
    PROTECTED_CONTAINER_NAMES.has(storedApp.containerName)
  ) {
    return {
      success: false,
      statusCode: 403,
      message: "System containers cannot be deleted"
    };
  }

  if (storedApp.containerName) {
    try {
      await dockerOps.removeContainer(storedApp.containerName);
    } catch (error) {
      // A 404 is exactly the state this path exists to handle — the
      // container is already gone, which is success, not failure.
      if (getErrorStatusCode(error) !== 404) {
        return {
          success: false,
          statusCode: getErrorStatusCode(error) ?? 500,
          message: "Unable to delete app"
        };
      }
    }
  }

  appDatabase.deleteApp(storedApp.id);

  if (storedApp.domain) {
    await reconcileRouting(appDatabase);
  }

  return {
    success: true,
    message: `${storedApp.name} was deleted.`,
    action: "deleted",
    name: storedApp.containerName ?? storedApp.name,
    appName: storedApp.name
  };
}

/**
 * Public entry point. Wraps `performDeleteApp` with idempotency-key handling
 * when `idempotencyKey` is present; behaves exactly as before when it is
 * absent, so existing callers are unaffected.
 *
 * This mirrors createAppWithConfig's idempotency wrapper (see
 * app-creation-service.ts and services/idempotency.ts) exactly, reusing the
 * same idempotency_keys table under a different scope:
 *   - A key never seen before reserves it, runs the deletion, and on SUCCESS
 *     caches the result for replay. A failure releases the key.
 *   - The SAME key against the SAME container id, once completed, replays the
 *     original success — this is what makes it safe for a request that is
 *     delivered twice (a connection dropped mid-request by the Caddy restart
 *     that route reconciliation performs, then retried) to end in success
 *     instead of a confusing 404 for a container that is, correctly, already
 *     gone.
 *   - The SAME key against a DIFFERENT container id is a mismatch, rejected
 *     outright.
 *   - A DIFFERENT key (or no key) for an app that is already gone is a real,
 *     unmodified 404 — idempotency never fabricates success for a request
 *     that isn't tied to the same operation.
 */
export async function deleteAppWithIdempotency(
  deps: DeleteAppServiceDependencies,
  containerId: string,
  idempotencyKey?: string
): Promise<DeleteAppServiceResult> {
  if (!idempotencyKey) {
    return performDeleteApp(deps, containerId);
  }

  const { appDatabase } = deps;
  const fingerprint = fingerprintDeleteAppRequest(containerId);
  const outcome = appDatabase.beginAttempt(
    idempotencyKey,
    APP_DELETION_IDEMPOTENCY_SCOPE,
    fingerprint
  );

  if (outcome.kind === "mismatch") {
    return {
      success: false,
      statusCode: 409,
      message:
        "This idempotency key was already used for a different request."
    };
  }

  if (outcome.kind === "in_progress") {
    return {
      success: false,
      statusCode: 409,
      message:
        "A request with this idempotency key is already being processed."
    };
  }

  if (outcome.kind === "replay") {
    return outcome.body as DeleteAppServiceResult;
  }

  const result = await performDeleteApp(deps, containerId);

  if (result.success) {
    appDatabase.complete(
      idempotencyKey,
      APP_DELETION_IDEMPOTENCY_SCOPE,
      200,
      result
    );
  } else {
    appDatabase.releaseFailedAttempt(
      idempotencyKey,
      APP_DELETION_IDEMPOTENCY_SCOPE
    );
  }

  return result;
}
