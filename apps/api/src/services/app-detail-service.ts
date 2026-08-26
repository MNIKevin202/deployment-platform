import type { StoredApp, StoredAppPublishedPort } from "../database.js";
import type { StoredDeployment } from "../deployment-database.js";
import type { EnvironmentStatus } from "./environment-service.js";
import type { ImageUpdateStatus } from "./image-update-check-service.js";

export interface AppDetailPublishedPort {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}

export interface ContainerInspection {
  id: string;
  state: {
    running: boolean;
    status: string;
    exitCode: number;
    startedAt: string;
    finishedAt: string;
  };
}

export interface AppDetail {
  id: number;
  name: string;
  status: string;
  desiredStatus: string;
  containerId: string | null;
  shortContainerId: string | null;
  containerName: string | null;
  image: string;
  containerPort: number;
  domain: string | null;
  internalOnly: boolean;
  routingReady: boolean;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt: string | null;
  lastDeploymentDurationMs: number | null;
  restartPolicy: string;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  /** Per-app rollback retention override; null means the global default applies. */
  deploymentRetention: number | null;
  containerExists: boolean;
  dockerState: string | null;
  dockerStatusText: string | null;
  environmentStatus: EnvironmentStatus;
  publishedPorts: AppDetailPublishedPort[];
  imageUpdateAvailable: boolean;
  imageUpdateCheckedAt: string | null;
}

/**
 * Docker's `inspect` response has no human-readable status string like the
 * one `listContainers` returns (e.g. "Up 5 minutes") — this derives an
 * equivalent from the State fields inspect does give us.
 */
export function formatDockerStatusText(
  state: ContainerInspection["state"]
): string {
  if (state.running) {
    return `Up since ${state.startedAt}`;
  }

  if (state.status === "exited" || state.status === "dead") {
    return `Exited (${state.exitCode}) at ${state.finishedAt}`;
  }

  return state.status;
}

/**
 * Pure mapping from a stored app + an optional live container inspection
 * into the API response shape, so it can be unit tested without a real
 * Docker daemon.
 */
export function buildAppDetail(
  storedApp: StoredApp,
  inspection: ContainerInspection | null,
  routingReady: boolean,
  environmentStatus: EnvironmentStatus,
  publishedPorts: StoredAppPublishedPort[] = [],
  imageUpdateStatus: ImageUpdateStatus | null = null,
  currentDeployment: StoredDeployment | null = null
): AppDetail {
  return {
    id: storedApp.id,
    name: storedApp.name,
    status: storedApp.status,
    desiredStatus: storedApp.desiredStatus,
    containerId: inspection?.id ?? storedApp.containerId,
    shortContainerId:
      (inspection?.id ?? storedApp.containerId)?.slice(0, 12) ?? null,
    containerName: storedApp.containerName,
    image: storedApp.image,
    containerPort: storedApp.containerPort,
    domain: storedApp.domain,
    internalOnly: storedApp.internalOnly,
    routingReady,
    createdAt: storedApp.createdAt,
    updatedAt: storedApp.updatedAt,
    lastDeployedAt: storedApp.lastDeployedAt,
    lastDeploymentDurationMs: currentDeployment?.durationMs ?? null,
    restartPolicy: storedApp.restartPolicy,
    memoryLimitMb: storedApp.memoryLimitMb,
    cpuLimit: storedApp.cpuLimit,
    deploymentRetention: storedApp.deploymentRetention,
    containerExists: inspection !== null,
    dockerState: inspection ? inspection.state.status : null,
    dockerStatusText: inspection
      ? formatDockerStatusText(inspection.state)
      : null,
    environmentStatus,
    publishedPorts: publishedPorts.map((port) => ({
      hostPort: port.hostPort,
      containerPort: port.containerPort,
      protocol: port.protocol
    })),
    imageUpdateAvailable: imageUpdateStatus?.updateAvailable ?? false,
    imageUpdateCheckedAt: imageUpdateStatus?.checkedAt ?? null
  };
}
