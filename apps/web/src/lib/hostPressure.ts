import type { StoredApp } from "../types/api";

export type HostPressureLevel = "ok" | "warning" | "over";

export interface HostPressure {
  /** Sum of memory limits set across apps, in MiB. */
  committedMb: number;
  /** Host total memory in MiB, or null if unknown. */
  hostTotalMb: number | null;
  /** How many apps have a memory limit set. */
  cappedCount: number;
  /** committed / host total (0 when unknown or nothing committed). */
  ratio: number;
  level: HostPressureLevel;
}

const WARNING_RATIO = 0.85;

/**
 * How much of the host's memory the apps' *declared* limits add up to. A
 * warning that committed limits approach (or exceed) the host total is a
 * heads-up that the host is over-subscribed — reduce limits or add memory.
 * Apps without a limit aren't counted (their usage is unbounded and not
 * knowable from limits alone).
 */
export function computeHostPressure(apps: StoredApp[], memoryTotalBytes: number | null): HostPressure {
  const committedMb = apps.reduce((sum, app) => sum + (app.memoryLimitMb ?? 0), 0);
  const cappedCount = apps.filter((app) => app.memoryLimitMb && app.memoryLimitMb > 0).length;
  const hostTotalMb = memoryTotalBytes && memoryTotalBytes > 0 ? memoryTotalBytes / (1024 * 1024) : null;
  const ratio = hostTotalMb && committedMb > 0 ? committedMb / hostTotalMb : 0;
  const level: HostPressureLevel = ratio > 1 ? "over" : ratio >= WARNING_RATIO ? "warning" : "ok";

  return { committedMb, hostTotalMb, cappedCount, ratio, level };
}

/** Formats a MiB value as a compact GB/MB string. */
export function formatMib(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}
