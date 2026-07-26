import type Docker from "dockerode";
import { getErrorStatusCode } from "../docker-errors.js";

export interface NormalizedMetrics {
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  pids: number | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Loosely typed — this is exactly the shape of dockerode's raw stats object. */
type RawDockerStats = Record<string, unknown>;

function getPath(obj: unknown, ...keys: Array<string | number>): unknown {
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string | number, unknown>)[key];
  }

  return current;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCpuPercent(raw: RawDockerStats): number | null {
  const cpuUsage = asNumber(getPath(raw, "cpu_stats", "cpu_usage", "total_usage"));
  const preCpuUsage = asNumber(getPath(raw, "precpu_stats", "cpu_usage", "total_usage"));
  const systemUsage = asNumber(getPath(raw, "cpu_stats", "system_cpu_usage"));
  const preSystemUsage = asNumber(getPath(raw, "precpu_stats", "system_cpu_usage"));

  if (cpuUsage === null || preCpuUsage === null || systemUsage === null || preSystemUsage === null) {
    return null;
  }

  const cpuDelta = cpuUsage - preCpuUsage;
  const systemDelta = systemUsage - preSystemUsage;

  if (systemDelta <= 0 || cpuDelta < 0) {
    return 0;
  }

  const percpu = getPath(raw, "cpu_stats", "cpu_usage", "percpu_usage");
  const onlineCpus =
    asNumber(getPath(raw, "cpu_stats", "online_cpus")) ??
    (Array.isArray(percpu) ? percpu.length : null) ??
    1;

  return round2((cpuDelta / systemDelta) * onlineCpus * 100);
}

function normalizeMemory(raw: RawDockerStats): {
  usageBytes: number | null;
  limitBytes: number | null;
  percent: number | null;
} {
  const usage = asNumber(getPath(raw, "memory_stats", "usage"));
  const limit = asNumber(getPath(raw, "memory_stats", "limit"));
  const cache =
    asNumber(getPath(raw, "memory_stats", "stats", "cache")) ??
    asNumber(getPath(raw, "memory_stats", "stats", "inactive_file")) ??
    0;

  // Docker's raw "usage" includes reclaimable page cache — subtract it so
  // this lines up with what `docker stats` shows, rather than overstating
  // real memory pressure.
  const usageBytes = usage !== null ? Math.max(0, usage - cache) : null;
  const limitBytes = limit !== null && limit > 0 ? limit : null;
  const percent =
    usageBytes !== null && limitBytes !== null ? round2((usageBytes / limitBytes) * 100) : null;

  return { usageBytes, limitBytes, percent };
}

function normalizeNetwork(raw: RawDockerStats): { rxBytes: number | null; txBytes: number | null } {
  const networks = getPath(raw, "networks");

  if (!networks || typeof networks !== "object") {
    return { rxBytes: null, txBytes: null };
  }

  let rx = 0;
  let tx = 0;
  let found = false;

  for (const iface of Object.values(networks as Record<string, unknown>)) {
    const rxBytes = asNumber(getPath(iface, "rx_bytes"));
    const txBytes = asNumber(getPath(iface, "tx_bytes"));

    if (rxBytes !== null) {
      rx += rxBytes;
      found = true;
    }

    if (txBytes !== null) {
      tx += txBytes;
      found = true;
    }
  }

  return found ? { rxBytes: rx, txBytes: tx } : { rxBytes: null, txBytes: null };
}

function normalizeBlockIo(raw: RawDockerStats): { readBytes: number | null; writeBytes: number | null } {
  const entries = getPath(raw, "blkio_stats", "io_service_bytes_recursive");

  if (!Array.isArray(entries)) {
    return { readBytes: null, writeBytes: null };
  }

  let read = 0;
  let write = 0;
  let found = false;

  for (const entry of entries) {
    const value = asNumber(getPath(entry, "value"));
    const op = typeof getPath(entry, "op") === "string" ? (getPath(entry, "op") as string).toLowerCase() : "";

    if (value === null) {
      continue;
    }

    if (op === "read") {
      read += value;
      found = true;
    } else if (op === "write") {
      write += value;
      found = true;
    }
  }

  return found ? { readBytes: read, writeBytes: write } : { readBytes: null, writeBytes: null };
}

/**
 * Converts Docker's raw (and somewhat erratic — fields are absent or zero
 * in various circumstances) stats payload into a flat, frontend-friendly
 * shape. Every field degrades to `null` independently rather than throwing
 * or making the whole response unavailable when one section is missing.
 */
export function normalizeDockerStats(raw: unknown): NormalizedMetrics {
  const stats: RawDockerStats = raw && typeof raw === "object" ? (raw as RawDockerStats) : {};

  const memory = normalizeMemory(stats);
  const network = normalizeNetwork(stats);
  const blockIo = normalizeBlockIo(stats);
  const pids = asNumber(getPath(stats, "pids_stats", "current"));

  return {
    cpuPercent: normalizeCpuPercent(stats),
    memoryUsageBytes: memory.usageBytes,
    memoryLimitBytes: memory.limitBytes,
    memoryPercent: memory.percent,
    networkRxBytes: network.rxBytes,
    networkTxBytes: network.txBytes,
    blockReadBytes: blockIo.readBytes,
    blockWriteBytes: blockIo.writeBytes,
    pids
  };
}

export interface ContainerMetricsSuccess {
  success: true;
  metrics: NormalizedMetrics;
}

export interface ContainerMetricsFailure {
  success: false;
  reason: "not-found" | "error";
  message: string;
}

export type ContainerMetricsResult = ContainerMetricsSuccess | ContainerMetricsFailure;

/**
 * Single unstreamed stats snapshot (`stream: false`) — never leaves a
 * Docker stats connection open.
 */
export async function getContainerMetrics(
  docker: Docker,
  containerId: string
): Promise<ContainerMetricsResult> {
  try {
    const container = docker.getContainer(containerId);
    const raw = await container.stats({ stream: false });

    return { success: true, metrics: normalizeDockerStats(raw) };
  } catch (error) {
    if (getErrorStatusCode(error) === 404) {
      return { success: false, reason: "not-found", message: "Container not found" };
    }

    return {
      success: false,
      reason: "error",
      message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
