import { computeHostPressure } from "./hostPressure";
import { isDatabaseImage } from "./appKind";
import type { ContainerSummary, DockerInfo, RoutingStatus, StoredApp } from "../types/api";

export type AttentionSeverity = "warning" | "critical";

export type AttentionCategory =
  | "stopped-app"
  | "deploy-failed"
  | "unhealthy-app"
  | "unhealthy-route"
  | "docker-unreachable"
  | "routing-degraded"
  | "disk-usage"
  | "backup-overdue"
  | "memory-pressure"
  | "cpu-pressure";

export interface AttentionItem {
  /** Stable, unique key for React lists — `${category}:${app?.id ?? "platform"}`. */
  id: string;
  severity: AttentionSeverity;
  category: AttentionCategory;
  message: string;
  /** Present for a per-app item; absent for a platform-wide one (disk, backup, routing, Docker). */
  app?: StoredApp;
}

export type PlatformHealthStatus = "healthy" | "warning" | "critical";

export interface PlatformHealthSummary {
  status: PlatformHealthStatus;
  items: AttentionItem[];
}

export interface AutoBackupStatus {
  enabled: boolean;
  intervalHours: number;
  lastRunAt: number | null;
}

export interface DiskUsageStatus {
  usedBytes: number;
  totalBytes: number;
}

export interface ComputePlatformHealthInput {
  managedApps: ContainerSummary[];
  storedAppsByName: Map<string, StoredApp>;
  dockerInfo: DockerInfo | null;
  routingStatus: RoutingStatus | null;
  diskUsage: DiskUsageStatus | null;
  autoBackup: AutoBackupStatus | null;
  now?: () => number;
}

const DEPLOY_FAILURE_EVENT_TYPES = new Set([
  "github-deploy-failed",
  "redeploy-failed",
  "revert-failed",
  "github-deploy-rolled-back"
]);

const DISK_WARNING_RATIO = 0.8;
const DISK_CRITICAL_RATIO = 0.9;

function appItem(category: AttentionCategory, severity: AttentionSeverity, message: string, app: StoredApp): AttentionItem {
  return { id: `${category}:${app.id}`, severity, category, message, app };
}

function platformItem(category: AttentionCategory, severity: AttentionSeverity, message: string): AttentionItem {
  return { id: `${category}:platform`, severity, category, message };
}

/**
 * Sum of every app's configured `cpuLimit` against the host's core count —
 * the CPU sibling of computeHostPressure's memory-commitment check. Cheap
 * (DB + dockerInfo only, no live Docker stats calls), matching the same
 * "declared limits vs host capacity" heuristic, not measured usage.
 */
function computeCpuPressureLevel(apps: StoredApp[], cpuCount: number | null): "ok" | "warning" | "over" {
  if (!cpuCount || cpuCount <= 0) {
    return "ok";
  }
  const committed = apps.reduce((sum, app) => sum + (app.cpuLimit ?? 0), 0);
  if (committed <= 0) {
    return "ok";
  }
  const ratio = committed / cpuCount;
  return ratio > 1 ? "over" : ratio >= 0.85 ? "warning" : "ok";
}

/**
 * Aggregates every "does this need attention" signal the platform already
 * has available into one summary for the Overview page. Pure and
 * deterministic — every input is data already fetched elsewhere (or one
 * cheap, cached poll for disk/backup) so this performs no I/O of its own.
 */
export function computePlatformHealth(input: ComputePlatformHealthInput): PlatformHealthSummary {
  const { managedApps, storedAppsByName, dockerInfo, routingStatus, diskUsage, autoBackup } = input;
  const now = input.now ?? (() => Date.now());
  const items: AttentionItem[] = [];

  // Docker unreachable is the one condition that makes every other
  // Docker-derived signal (runtime state, routing) unreliable — surface it
  // once, platform-wide, rather than a false "stopped" per app.
  const dockerReachable = dockerInfo?.status === "connected";
  if (!dockerReachable) {
    items.push(platformItem("docker-unreachable", "critical", "Docker is unreachable — app status may be stale."));
  }

  if (dockerReachable) {
    for (const container of managedApps) {
      if (isDatabaseImage(container.image)) {
        continue;
      }
      if (container.state === "running") {
        continue;
      }
      const appName = container.labels["com.deployment-platform.app-name"];
      const app = appName ? storedAppsByName.get(appName) : undefined;
      if (app) {
        items.push(appItem("stopped-app", "warning", `${app.name} is stopped.`, app));
      }
    }
  }

  for (const app of storedAppsByName.values()) {
    if (app.latestEventSeverity === "error" && app.latestEventType && DEPLOY_FAILURE_EVENT_TYPES.has(app.latestEventType)) {
      items.push(appItem("deploy-failed", "warning", `${app.name}'s last deployment failed.`, app));
    }

    if (app.health && (app.health.state === "unhealthy" || app.health.state === "error")) {
      items.push(appItem("unhealthy-app", "warning", `${app.name} is failing its health check.`, app));
    }

    if (app.domain && !app.internalOnly && !app.routingReady) {
      items.push(appItem("unhealthy-route", "warning", `${app.name}'s public route isn't active.`, app));
    }
  }

  if (routingStatus?.enabled && routingStatus.lastReconcileSucceeded === false) {
    items.push(
      platformItem(
        "routing-degraded",
        "warning",
        `Routing failed to reconcile${routingStatus.lastError ? `: ${routingStatus.lastError}` : "."}`
      )
    );
  }

  if (diskUsage && diskUsage.totalBytes > 0) {
    const ratio = diskUsage.usedBytes / diskUsage.totalBytes;
    if (ratio >= DISK_CRITICAL_RATIO) {
      items.push(platformItem("disk-usage", "critical", `Disk is ${Math.round(ratio * 100)}% full.`));
    } else if (ratio >= DISK_WARNING_RATIO) {
      items.push(platformItem("disk-usage", "warning", `Disk is ${Math.round(ratio * 100)}% full.`));
    }
  }

  if (autoBackup?.enabled) {
    const overdue =
      autoBackup.lastRunAt === null || now() - autoBackup.lastRunAt > autoBackup.intervalHours * 3_600_000;
    if (overdue) {
      items.push(
        platformItem(
          "backup-overdue",
          "warning",
          autoBackup.lastRunAt === null ? "Automatic backup is enabled but has never run." : "Automatic backup is overdue."
        )
      );
    }
  }

  const apps = Array.from(storedAppsByName.values());
  const memoryPressure = computeHostPressure(apps, dockerInfo?.memoryTotalBytes ?? null);
  if (memoryPressure.level === "over") {
    items.push(platformItem("memory-pressure", "critical", "Memory limits committed across apps exceed the host's total memory."));
  } else if (memoryPressure.level === "warning") {
    items.push(platformItem("memory-pressure", "warning", "Memory limits committed across apps are nearly at the host's total memory."));
  }

  const cpuPressure = computeCpuPressureLevel(apps, dockerInfo?.cpuCount ?? null);
  if (cpuPressure === "over") {
    items.push(platformItem("cpu-pressure", "critical", "CPU limits committed across apps exceed the host's core count."));
  } else if (cpuPressure === "warning") {
    items.push(platformItem("cpu-pressure", "warning", "CPU limits committed across apps are nearly at the host's core count."));
  }

  const status: PlatformHealthStatus = items.some((item) => item.severity === "critical")
    ? "critical"
    : items.length > 0
      ? "warning"
      : "healthy";

  return { status, items };
}
