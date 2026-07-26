import type { AppDatabase, StoredApp } from "../database.js";
import {
  errorMessage,
  type RedeployDockerOps,
  type RedeployReconcileResult
} from "./redeploy-service.js";
import { buildContainerEnvArray } from "./environment-service.js";
import {
  buildVolumeMounts,
  generateUniqueVolumeName,
  isReservedVolumeName
} from "./storage-service.js";
import type { RecordEventFn } from "./deployment-event-service.js";

export interface AppCreationEnvVarInput {
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
}

export interface AppCreationVolumeInput {
  containerPath: string;
  volumeName?: string;
  readOnly: boolean;
}

export interface CreateAppWithConfigInput {
  name: string;
  image: string;
  containerPort: number;
  restartPolicy?: string;
  environmentVariables?: AppCreationEnvVarInput[];
  storageMounts?: AppCreationVolumeInput[];
}

export interface CreateAppServiceDependencies {
  appDatabase: AppDatabase;
  dockerOps: RedeployDockerOps;
  buildDomain: (name: string) => string;
  reconcileRouting: (
    appDatabase: AppDatabase
  ) => Promise<RedeployReconcileResult>;
  isRoutingReady: (hasDomain: boolean) => boolean;
  recordEvent: RecordEventFn;
}

export interface CreatedAppSummary {
  id: number;
  name: string;
  containerName: string;
  image: string;
  containerPort: number;
  domain: string | null;
  containerId: string | null;
  status: string;
  routingReady: boolean;
  environmentVariableCount: number;
  secretVariableCount: number;
  storageMountCount: number;
}

/**
 * What cleanup actually accomplished after a Docker-phase creation failure.
 * Reported separately from the failure message itself so a caller (or a
 * test) can check each piece precisely instead of parsing prose.
 */
export interface CreationCleanupReport {
  /** True if no container existed yet, or it was successfully removed. */
  containerRemoved: boolean;
  /** Docker ID of a container that still exists and needs manual removal. */
  leftoverContainerId: string | null;
  /** True if the app's database record was removed (or never existed). */
  appRecordRemoved: boolean;
  /** True if the app record could not be removed and may need manual repair. */
  staleAppRecord: boolean;
}

export interface CreateAppServiceResult {
  success: boolean;
  message: string;
  /** HTTP status the caller should use on failure. Absent on success. */
  statusCode?: number;
  app?: CreatedAppSummary;
  /** Present only on a Docker-phase failure — never on success. */
  cleanup?: CreationCleanupReport;
}

/**
 * Attempts to remove a newly created (but never successfully deployed)
 * container and its app database record. Never throws — each piece is
 * attempted independently and its own failure is recorded in the report
 * rather than allowed to mask the other or the original creation error.
 * Named Docker volumes are never touched here.
 */
async function cleanupAfterDockerFailure(
  appDatabase: AppDatabase,
  dockerOps: RedeployDockerOps,
  appId: number,
  containerId: string | null
): Promise<CreationCleanupReport> {
  let containerRemoved = true;
  let leftoverContainerId: string | null = null;

  if (containerId) {
    try {
      await dockerOps.removeContainer(containerId);
    } catch {
      containerRemoved = false;
      leftoverContainerId = containerId;
    }
  }

  let appRecordRemoved = true;
  let staleAppRecord = false;

  try {
    appDatabase.deleteApp(appId);
  } catch {
    appRecordRemoved = false;
    staleAppRecord = true;
  }

  return { containerRemoved, leftoverContainerId, appRecordRemoved, staleAppRecord };
}

/**
 * Runs cleanup and assembles the failure result. `containerId` is null when
 * the failure happened before createContainer() ever returned an id (pull
 * or volume preparation) — in that case there is nothing to remove, so the
 * message never claims a container was cleaned up. The original error
 * always leads the message; cleanup outcomes are appended, never
 * substituted for it.
 */
async function failDockerCreation(
  appDatabase: AppDatabase,
  dockerOps: RedeployDockerOps,
  recordEvent: RecordEventFn,
  appId: number,
  containerId: string | null,
  originalErrorMessage: string
): Promise<CreateAppServiceResult> {
  const cleanup = await cleanupAfterDockerFailure(
    appDatabase,
    dockerOps,
    appId,
    containerId
  );

  // Only worth recording if the app row is still there to reference — once
  // it's actually gone, an event pointing at it can never be read back.
  if (cleanup.staleAppRecord) {
    recordEvent({
      appId,
      eventType: "cleanup-warning",
      severity: "error",
      message: "App creation failed and its database record could not be automatically removed",
      metadata: {
        leftoverContainerId: cleanup.leftoverContainerId,
        containerRemoved: cleanup.containerRemoved
      }
    });
  }

  const cleanupParts: string[] = [];

  if (containerId) {
    cleanupParts.push(
      cleanup.leftoverContainerId
        ? `the new container (id ${cleanup.leftoverContainerId}) could not be removed automatically and needs manual cleanup`
        : "the new container was removed"
    );
  }

  cleanupParts.push(
    cleanup.staleAppRecord
      ? "the app's database record could not be removed and may need manual repair"
      : "the app's database record was removed"
  );

  return {
    success: false,
    statusCode: 502,
    message: `Unable to create the app container: ${originalErrorMessage} (${cleanupParts.join("; ")}.)`,
    cleanup
  };
}

/**
 * The single authoritative "create a managed app" implementation. Both the
 * original minimal endpoint and the wizard endpoint call this with the
 * same shape of input (the minimal endpoint just passes empty
 * environmentVariables/storageMounts arrays) so there is exactly one code
 * path that can create an app, rather than two that could drift apart.
 */
export async function createAppWithConfig(
  deps: CreateAppServiceDependencies,
  input: CreateAppWithConfigInput
): Promise<CreateAppServiceResult> {
  const {
    appDatabase,
    dockerOps,
    buildDomain,
    reconcileRouting,
    isRoutingReady,
    recordEvent
  } = deps;

  const containerName = `app-${input.name}`;
  const domain = buildDomain(input.name);
  const exposedPort = `${input.containerPort}/tcp`;
  const restartPolicy = input.restartPolicy || "unless-stopped";
  const envVars = input.environmentVariables ?? [];
  const volumeInputs = input.storageMounts ?? [];

  if (appDatabase.getAppByName(input.name)) {
    return {
      success: false,
      statusCode: 409,
      message: `An app named "${input.name}" already exists`
    };
  }

  if (appDatabase.getAppByDomain(domain)) {
    return {
      success: false,
      statusCode: 409,
      message: `Domain "${domain}" is already assigned to another app`
    };
  }

  // Resolve/validate every volume name up front, before any database
  // write, so a naming problem can never leave a half-created app behind.
  const resolvedVolumes: Array<{
    volumeName: string;
    containerPath: string;
    readOnly: boolean;
  }> = [];
  const claimedVolumeNames = new Set<string>();

  for (const mount of volumeInputs) {
    let volumeName = mount.volumeName;

    if (volumeName) {
      if (isReservedVolumeName(volumeName)) {
        return {
          success: false,
          statusCode: 400,
          message: `Volume name "${volumeName}" is reserved for platform use`
        };
      }

      if (
        claimedVolumeNames.has(volumeName) ||
        appDatabase.getAppVolumeByName(volumeName)
      ) {
        return {
          success: false,
          statusCode: 409,
          message: `Volume name "${volumeName}" is already in use`
        };
      }
    } else {
      try {
        volumeName = generateUniqueVolumeName(
          input.name,
          mount.containerPath,
          (name) =>
            claimedVolumeNames.has(name) ||
            Boolean(appDatabase.getAppVolumeByName(name))
        );
      } catch (error) {
        return { success: false, statusCode: 500, message: errorMessage(error) };
      }
    }

    claimedVolumeNames.add(volumeName);
    resolvedVolumes.push({
      volumeName,
      containerPath: mount.containerPath,
      readOnly: mount.readOnly
    });
  }

  // Coordinated write: the app row, its environment variables, and its
  // storage records are created in one transaction — all or nothing.
  let createdApp: StoredApp;

  try {
    createdApp = appDatabase.withTransaction(() => {
      const app = appDatabase.createApp({
        name: input.name,
        image: input.image,
        containerPort: input.containerPort,
        containerName,
        domain,
        restartPolicy
      });

      for (const envVar of envVars) {
        appDatabase.createAppEnvVar({
          appId: app.id,
          key: envVar.key,
          value: envVar.value,
          isSecret: envVar.isSecret,
          enabled: envVar.enabled
        });
      }

      for (const volume of resolvedVolumes) {
        appDatabase.createAppVolume({
          appId: app.id,
          volumeName: volume.volumeName,
          containerPath: volume.containerPath,
          readOnly: volume.readOnly
        });
      }

      return app;
    });
  } catch (error) {
    return {
      success: false,
      statusCode: 500,
      message: `Unable to save app configuration: ${errorMessage(error)}`
    };
  }

  // Docker creation, split into two phases. Nothing exists yet during the
  // first phase (pull/volume prep/createContainer), so a failure there has
  // no container to clean up — only the database record. Once
  // createContainer() returns an id, the platform owns a real container,
  // so every failure from that point on (start, inspect, the running
  // check, or the database metadata write) must attempt to remove it
  // before rolling back the database record. Named volumes are never
  // deleted by any of this.
  let containerId: string | null = null;

  try {
    await dockerOps.pullImage(input.image);

    for (const volume of resolvedVolumes) {
      await dockerOps.ensureVolume(volume.volumeName, input.name);
    }

    const envArray = buildContainerEnvArray(
      appDatabase.listGlobalEnvVars(),
      appDatabase.listAppEnvVars(createdApp.id)
    );

    const mounts = buildVolumeMounts(
      appDatabase.listAppVolumes(createdApp.id)
    );

    const created = await dockerOps.createContainer({
      name: containerName,
      Image: input.image,
      Env: envArray,
      Labels: {
        "com.deployment-platform.managed": "true",
        "com.deployment-platform.app-name": input.name
      },
      ExposedPorts: {
        [exposedPort]: {}
      },
      HostConfig: {
        NetworkMode: "deployment-apps",
        RestartPolicy: {
          Name: restartPolicy
        },
        Mounts: mounts
      }
    });

    containerId = created.id;
  } catch (error) {
    return failDockerCreation(
      appDatabase,
      dockerOps,
      recordEvent,
      createdApp.id,
      null,
      errorMessage(error)
    );
  }

  if (!containerId) {
    // Unreachable — the try block above either assigns containerId or
    // returns via its catch — but narrows the type below explicitly rather
    // than relying on control-flow inference across the try/catch.
    return failDockerCreation(
      appDatabase,
      dockerOps,
      recordEvent,
      createdApp.id,
      null,
      "Container was not created"
    );
  }

  try {
    await dockerOps.startContainer(containerId);

    const inspected = await dockerOps.inspectContainer(containerId);

    if (!inspected.running) {
      throw new Error(
        `New container failed to reach a running state (status: ${inspected.status})`
      );
    }

    appDatabase.updateAppContainer(createdApp.id, {
      containerId: inspected.id,
      status: inspected.status
    });
  } catch (error) {
    return failDockerCreation(
      appDatabase,
      dockerOps,
      recordEvent,
      createdApp.id,
      containerId,
      errorMessage(error)
    );
  }

  // The container exists, is running, and the database reflects it — this
  // app is a success from here on. Routing is best-effort: a failure here
  // must not undo a container that is actually up and serving.
  let routingWarning: string | null = null;

  try {
    const routingStatus = await reconcileRouting(appDatabase);

    if (routingStatus.lastReconcileSucceeded === false) {
      routingWarning = `routing could not be updated: ${routingStatus.lastError ?? "unknown error"}`;
    }
  } catch (error) {
    routingWarning = `routing reconciliation failed: ${errorMessage(error)}`;
  }

  const finalApp = appDatabase.getAppById(createdApp.id);

  if (!finalApp) {
    return {
      success: false,
      statusCode: 500,
      message:
        "App was created, but its record could not be reloaded afterward."
    };
  }

  recordEvent({
    appId: finalApp.id,
    eventType: "app-created",
    severity: "info",
    message: `App "${finalApp.name}" was created`,
    metadata: {
      image: finalApp.image,
      containerPort: finalApp.containerPort,
      environmentVariableCount: envVars.length,
      storageMountCount: resolvedVolumes.length
    }
  });

  if (routingWarning) {
    recordEvent({
      appId: finalApp.id,
      eventType: "routing-warning",
      severity: "warning",
      message: `Routing warning while creating "${finalApp.name}": ${routingWarning}`
    });
  }

  return {
    success: true,
    message: routingWarning
      ? `App created successfully, but ${routingWarning}.`
      : "App created successfully.",
    app: {
      id: finalApp.id,
      name: finalApp.name,
      containerName: finalApp.containerName ?? containerName,
      image: finalApp.image,
      containerPort: finalApp.containerPort,
      domain: finalApp.domain,
      containerId: finalApp.containerId,
      status: finalApp.status,
      routingReady: isRoutingReady(finalApp.domain !== null),
      environmentVariableCount: envVars.length,
      secretVariableCount: envVars.filter((envVar) => envVar.isSecret).length,
      storageMountCount: resolvedVolumes.length
    }
  };
}
