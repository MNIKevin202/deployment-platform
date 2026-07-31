import type { AppDatabase, StoredApp } from "../database.js";
import { resolveAppDomainChoice } from "../domain.js";
import {
  errorMessage,
  type RedeployDockerOps,
  type RedeployReconcileResult
} from "./redeploy-service.js";
import { buildContainerEnvArray } from "./environment-service.js";
import { buildResourceHostConfig } from "./resource-limits.js";
import { buildPublishedPortConfig, isValidPort } from "./port-bindings.js";
import {
  buildVolumeMounts,
  generateUniqueVolumeName,
  isReservedVolumeName
} from "./storage-service.js";
import type { RecordEventFn } from "./deployment-event-service.js";
import {
  APP_CREATION_IDEMPOTENCY_SCOPE,
  fingerprintCreateAppRequest
} from "./idempotency.js";

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

export interface AppCreationPublishedPortInput {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}

export interface CreateAppWithConfigInput {
  name: string;
  image: string;
  containerPort: number;
  restartPolicy?: string;
  memoryLimitMb?: number | null;
  cpuLimit?: number | null;
  environmentVariables?: AppCreationEnvVarInput[];
  storageMounts?: AppCreationVolumeInput[];
  /**
   * Raw TCP/UDP ports to publish on the host, for non-HTTP services (game
   * servers, etc.) that can't be reached through the HTTP reverse proxy.
   * Defaults to none — the existing behavior where apps publish no host ports.
   */
  publishedPorts?: AppCreationPublishedPortInput[];
  /**
   * When true, this app never receives a public domain/route — see
   * domain.ts's resolveAppDomainChoice. Mutually exclusive with
   * `customDomain`. Defaults to false (the existing, unchanged behavior:
   * every app gets the generated default domain).
   */
  internalOnly?: boolean;
  /**
   * An operator-supplied custom domain (e.g. `roadmapstudio.xyz`) instead
   * of the generated `${name}.${APPS_DOMAIN}` default. Ignored/rejected
   * when `internalOnly` is true.
   */
  customDomain?: string;
  /**
   * A browser-generated key identifying this create ATTEMPT (one user
   * action, including any transport-level retry of that same underlying
   * request). Optional for backward compatibility with callers that don't
   * send one; when present, a repeated request with the same key returns
   * the original result instead of re-running the creation or returning a
   * misleading "already exists" error. See services/idempotency.ts.
   */
  idempotencyKey?: string;
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
  internalOnly: boolean;
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
 *
 * This is the actual creation logic; `createAppWithConfig` below wraps it
 * with idempotency-key handling so a repeated request (a real double
 * submit, or a transport-level retry after the connection was interrupted
 * mid-request — see routing-service.ts's Caddy-restart apply path) is
 * answered with the original result instead of running this twice.
 */
async function performCreateAppWithConfig(
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

  const domainChoice = resolveAppDomainChoice(
    input.name,
    { internalOnly: input.internalOnly ?? false, customDomain: input.customDomain },
    process.env,
    buildDomain
  );

  if (!domainChoice.ok) {
    return {
      success: false,
      statusCode: domainChoice.statusCode,
      message: domainChoice.error
    };
  }

  const { domain, internalOnly } = domainChoice;
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

  if (domain && appDatabase.getAppByDomain(domain)) {
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

  // Validate every published port up front — before any database write — so a
  // bad or already-claimed port can never leave a half-created app behind.
  const portInputs = input.publishedPorts ?? [];
  const claimedHostPorts = new Set<string>();

  for (const port of portInputs) {
    const protocol = port.protocol === "udp" ? "udp" : "tcp";

    if (!isValidPort(port.hostPort) || !isValidPort(port.containerPort)) {
      return {
        success: false,
        statusCode: 400,
        message: `Published ports must be between 1 and 65535 (got host ${port.hostPort}, container ${port.containerPort})`
      };
    }

    const claimKey = `${port.hostPort}/${protocol}`;

    if (claimedHostPorts.has(claimKey)) {
      return {
        success: false,
        statusCode: 400,
        message: `Host port ${port.hostPort}/${protocol} is listed more than once`
      };
    }

    const conflict = appDatabase.getAppPublishedPortByHost(port.hostPort, protocol);
    if (conflict) {
      return {
        success: false,
        statusCode: 409,
        message: `Host port ${port.hostPort}/${protocol} is already published by another app`
      };
    }

    claimedHostPorts.add(claimKey);
  }

  const resolvedPorts = portInputs.map((port) => ({
    hostPort: port.hostPort,
    containerPort: port.containerPort,
    protocol: (port.protocol === "udp" ? "udp" : "tcp") as "tcp" | "udp"
  }));

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
        internalOnly,
        restartPolicy,
        memoryLimitMb: input.memoryLimitMb ?? null,
        cpuLimit: input.cpuLimit ?? null
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

      for (const port of resolvedPorts) {
        appDatabase.createAppPublishedPort({
          appId: app.id,
          hostPort: port.hostPort,
          containerPort: port.containerPort,
          protocol: port.protocol
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

    const portConfig = buildPublishedPortConfig(
      appDatabase.listAppPublishedPorts(createdApp.id)
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
        [exposedPort]: {},
        ...portConfig.ExposedPorts
      },
      HostConfig: {
        NetworkMode: "deployment-apps",
        RestartPolicy: {
          Name: restartPolicy
        },
        Mounts: mounts,
        PortBindings: portConfig.PortBindings,
        ...buildResourceHostConfig(createdApp)
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
      internalOnly: finalApp.internalOnly,
      containerId: finalApp.containerId,
      status: finalApp.status,
      routingReady: isRoutingReady(finalApp.domain !== null),
      environmentVariableCount: envVars.length,
      secretVariableCount: envVars.filter((envVar) => envVar.isSecret).length,
      storageMountCount: resolvedVolumes.length
    }
  };
}

/**
 * Public entry point. Wraps `performCreateAppWithConfig` with idempotency-key
 * handling when `input.idempotencyKey` is present; behaves exactly as before
 * when it is absent, so existing callers are unaffected.
 *
 * Design (see services/idempotency.ts and idempotency-database.ts for the
 * storage/retention details):
 *   - A key never seen before reserves it, runs creation, and on SUCCESS
 *     caches the full result for replay. A failure releases the key so a
 *     genuine retry can run creation again from scratch — failures are
 *     never cached or replayed, only successes.
 *   - The SAME key with the SAME request body, once completed, replays the
 *     original success result verbatim rather than re-creating or hitting
 *     the "already exists" check — this is what makes a request that is
 *     delivered twice (double click, or a connection dropped and silently
 *     retried mid-request) safe.
 *   - The SAME key with a DIFFERENT request body is a key-reuse conflict,
 *     not a retry, and is rejected outright — it is never treated as
 *     idempotent with the original request.
 *   - The unique app-name constraint is unchanged: a genuinely different
 *     attempt (a different key) for a name that is already taken is a real
 *     409 "already exists", not something idempotency ever bypasses.
 */
export async function createAppWithConfig(
  deps: CreateAppServiceDependencies,
  input: CreateAppWithConfigInput
): Promise<CreateAppServiceResult> {
  const { idempotencyKey, ...createInput } = input;

  if (!idempotencyKey) {
    return performCreateAppWithConfig(deps, createInput);
  }

  const { appDatabase } = deps;
  const fingerprint = fingerprintCreateAppRequest(createInput);
  const outcome = appDatabase.beginAttempt(
    idempotencyKey,
    APP_CREATION_IDEMPOTENCY_SCOPE,
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
    return outcome.body as CreateAppServiceResult;
  }

  const result = await performCreateAppWithConfig(deps, createInput);

  if (result.success) {
    appDatabase.complete(
      idempotencyKey,
      APP_CREATION_IDEMPOTENCY_SCOPE,
      201,
      result
    );
  } else {
    appDatabase.releaseFailedAttempt(
      idempotencyKey,
      APP_CREATION_IDEMPOTENCY_SCOPE
    );
  }

  return result;
}
