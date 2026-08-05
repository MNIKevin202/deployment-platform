import { statfs as realStatfs } from "node:fs/promises";
import type Docker from "dockerode";

/**
 * A live, point-in-time snapshot of Docker's own resource counts and disk
 * footprint, for the Maintenance page's "Current Docker Usage" card. Counts
 * are the raw Docker totals (every container/image/volume, not just
 * platform-managed ones) — the same numbers `docker system df`/`docker ps -a`
 * would report, so what the operator sees here always matches what they'd
 * see on the host directly.
 */
export interface DockerUsageSnapshot {
  images: number;
  containers: number;
  volumes: number;
  /** Docker's own accounting of total image disk usage (shared-layer aware — not a naive sum of each image's Size). */
  imagesSizeBytes: number;
}

export interface HostDiskUsage {
  usedBytes: number;
  totalBytes: number;
}

/** The narrow slice of dockerode this snapshot needs — kept small so it's fake-able in tests without a real Docker daemon. */
export interface DockerUsageOps {
  listImages(): Promise<unknown[]>;
  listContainers(options: { all: boolean }): Promise<unknown[]>;
  listVolumes(): Promise<{ Volumes?: unknown[] | null }>;
  df(): Promise<{ LayersSize?: number }>;
}

/**
 * Image/container/volume counts come from the three list endpoints directly
 * (accurate and simple); imagesSizeBytes comes from `docker system df`'s
 * LayersSize, since that already accounts for shared base layers — summing
 * each image's own `Size` field would double-count layers shared across
 * builds and wildly overstate real usage (this is exactly why the old
 * "candidates * their size" preview overestimated reclaimable space).
 */
export async function getDockerUsageSnapshot(docker: Docker | DockerUsageOps): Promise<DockerUsageSnapshot> {
  const ops = docker as DockerUsageOps;
  const [images, containers, volumes, df] = await Promise.all([
    ops.listImages(),
    ops.listContainers({ all: true }),
    ops.listVolumes(),
    ops.df()
  ]);

  return {
    images: images.length,
    containers: containers.length,
    volumes: (volumes.Volumes ?? []).length,
    imagesSizeBytes: typeof df?.LayersSize === "number" ? df.LayersSize : 0
  };
}

export interface StatfsResult {
  blocks: number;
  bsize: number;
  bavail: number;
}

/**
 * Host filesystem usage for the path Docker's data lives under (defaults to
 * `/`, a reasonable proxy on a typical single-disk VPS). Used bytes is total
 * minus available-to-unprivileged-users (`bavail`), matching what `df -h`
 * reports as "Used" — not `bfree`, which includes space reserved for root and
 * would understate how full the disk looks to an operator. `statfsFn` is
 * injectable so the byte math is unit-testable without a real filesystem.
 */
export async function getHostDiskUsage(
  path: string = "/",
  statfsFn: (path: string) => Promise<StatfsResult> = realStatfs
): Promise<HostDiskUsage> {
  const stats = await statfsFn(path);
  const totalBytes = stats.blocks * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  return {
    totalBytes,
    usedBytes: Math.max(0, totalBytes - availableBytes)
  };
}
