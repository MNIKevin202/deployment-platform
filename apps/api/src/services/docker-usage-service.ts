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
  runningContainers: number;
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
  listContainers(options: { all: boolean }): Promise<{ State?: string }[]>;
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
 * `runningContainers` is derived from the same `all: true` listing (each
 * entry's own `State`), rather than a second call, so a running vs. total
 * count is always consistent with itself.
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
    runningContainers: containers.filter((container) => container.State === "running").length,
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

export interface CombinedUsage {
  usage: DockerUsageSnapshot;
  disk: HostDiskUsage;
}

export interface DockerUsageProviderOptions {
  /** How long a successful result stays fresh before a new lookup is attempted, in ms. Default 30s. */
  ttlMs?: number;
  /** How long to wait for Docker before giving up and reporting a timeout, in ms. Default 5s. */
  timeoutMs?: number;
  now?: () => number;
  /** Test-only override for the underlying fetch — bypasses the real docker/statfs calls. */
  fetchUsage?: () => Promise<CombinedUsage>;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface DockerUsageProvider {
  getUsage(): Promise<CombinedUsage>;
  /**
   * Drops any cached result so the next getUsage() call fetches fresh data
   * instead of serving a stale snapshot. Called after a cleanup actually
   * changes Docker's state — without it, the Maintenance page could keep
   * showing pre-cleanup counts for up to the full cache TTL after a cleanup
   * the operator just watched finish. Never cancels an in-flight fetch;
   * that attempt still populates a fresh cache entry when it resolves.
   */
  invalidate(): void;
}

/**
 * A cached, timeout-bounded, single-flight wrapper around the raw Docker
 * usage lookup — required because `docker system df` (behind
 * getDockerUsageSnapshot) is known to get slow on a host with many
 * images/containers, and this snapshot is read on every Maintenance page
 * load plus a periodic background poll. Without this wrapper, a slow `df()`
 * call combined with polling would let overlapping requests pile up
 * indefinitely, each one adding more load to an already-strained Docker
 * daemon and leaving every page load hung waiting on a request that never
 * returns (exactly what happened in production before this was added).
 *
 * Three protections, each independently sufficient to prevent that:
 *  - a hard timeout, so a single lookup can never hang the caller forever;
 *  - a short TTL cache, so a fast page refresh or the background poll reuses
 *    a still-fresh result instead of re-querying Docker;
 *  - single-flight de-duplication, so concurrent callers (e.g. two open
 *    tabs, or a poll tick overlapping a manual refresh) share one in-flight
 *    lookup rather than each starting their own.
 *
 * Create exactly one of these per process (in server.ts) so the cache and
 * in-flight de-duplication are shared across every request.
 */
export function createDockerUsageProvider(
  docker: Docker,
  options: DockerUsageProviderOptions = {}
): DockerUsageProvider {
  const ttlMs = options.ttlMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  const fetchUsage =
    options.fetchUsage ??
    (() =>
      Promise.all([getDockerUsageSnapshot(docker), getHostDiskUsage()]).then(([usage, disk]) => ({
        usage,
        disk
      })));
  const setTimeoutFn = options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let cached: { value: CombinedUsage; expiresAt: number } | null = null;
  let inFlight: Promise<CombinedUsage> | null = null;

  async function fetchFresh(): Promise<CombinedUsage> {
    let timerHandle: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timerHandle = setTimeoutFn(() => {
        reject(
          new Error(
            `Docker usage lookup timed out after ${timeoutMs}ms — the host may be under heavy Docker load (many images/containers).`
          )
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([fetchUsage(), timeout]);
    } finally {
      clearTimeoutFn(timerHandle);
    }
  }

  return {
    async getUsage(): Promise<CombinedUsage> {
      if (cached && cached.expiresAt > now()) {
        return cached.value;
      }
      if (inFlight) {
        return inFlight;
      }

      const attempt = fetchFresh();
      inFlight = attempt;

      try {
        const value = await attempt;
        cached = { value, expiresAt: now() + ttlMs };
        return value;
      } finally {
        // Only clear if this attempt is still the current one — a slow,
        // now-timed-out attempt finishing late must never clobber a newer
        // in-flight attempt that started after it gave up.
        if (inFlight === attempt) {
          inFlight = null;
        }
      }
    },
    invalidate(): void {
      cached = null;
    }
  };
}
