import type Docker from "dockerode";
import type { AppDatabase } from "../database.js";
import { getErrorStatusCode } from "../docker-errors.js";

/**
 * Deployment retention: after every deploy (and once daily as a safety net),
 * keep only the newest N rollback versions per app and reclaim everything
 * older — the per-commit `deployment-app-<id>:<sha>` image, its ledger row,
 * and any leftover rollback/temp containers. The design is deliberately
 * defensive: nothing here can ever remove a running container's image, the
 * current version, a shared/referenced image, or any Docker volume, and every
 * runner is best-effort (it never throws) so a cleanup failure can never fail
 * a deployment.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_RETENTION_COUNT = 3;
export const DEFAULT_PLATFORM_IMAGE_KEEP = 3;
const MIN_RETENTION_COUNT = 1;
const MAX_RETENTION_COUNT = 50;
const MAX_PLATFORM_IMAGE_KEEP = 50;

export interface RetentionConfig {
  /** How many recent rollback versions to keep per app. */
  count: number;
  /** How many recent platform (`deployment-platform-*`) images to keep per repo. */
  platformImageKeep: number;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  count: DEFAULT_RETENTION_COUNT,
  platformImageKeep: DEFAULT_PLATFORM_IMAGE_KEEP
};

/** Clamps a retention count into [1, 50]; always keeps at least the current version. */
export function clampRetentionCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_RETENTION_COUNT;
  }
  return Math.min(MAX_RETENTION_COUNT, Math.max(MIN_RETENTION_COUNT, Math.floor(value)));
}

/** Clamps the platform-image keep count into [0, 50]. */
export function clampPlatformImageKeep(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PLATFORM_IMAGE_KEEP;
  }
  return Math.min(MAX_PLATFORM_IMAGE_KEEP, Math.max(0, Math.floor(value)));
}

/** Normalizes a possibly-partial stored config into a fully-clamped one. */
export function normalizeRetentionConfig(raw: Partial<RetentionConfig> | null | undefined): RetentionConfig {
  return {
    count: clampRetentionCount(raw?.count ?? DEFAULT_RETENTION_COUNT),
    platformImageKeep: clampPlatformImageKeep(raw?.platformImageKeep ?? DEFAULT_PLATFORM_IMAGE_KEEP)
  };
}

/** The effective retention for one app: its per-app override, else the global count. */
export function resolveRetentionCount(
  app: { deploymentRetention: number | null },
  globalCount: number
): number {
  return clampRetentionCount(app.deploymentRetention ?? globalCount);
}

// ---------------------------------------------------------------------------
// Pure planning — no Docker, deterministic, unit-testable
// ---------------------------------------------------------------------------

const DEPLOYMENT_APP_TAG = /^deployment-app-\d+:/;
const PLATFORM_IMAGE_REPOS = new Set(["deployment-platform-api", "deployment-platform-web"]);

export interface RetentionDeployment {
  version: number;
  imageTag: string;
  isCurrent: boolean;
}

export interface AppRetentionInput {
  appId: number;
  /** The app's current image (`app.image`) — always protected. */
  currentImageTag: string;
  retentionCount: number;
  /** The app's GitHub deployments, in any order. */
  deployments: RetentionDeployment[];
}

export interface AppRetentionDecision {
  appId: number;
  retainedVersions: number[];
  prunedVersions: { version: number; imageTag: string }[];
}

export interface RetentionPlan {
  perApp: AppRetentionDecision[];
  /**
   * Every image tag still referenced by a retained version anywhere, plus each
   * app's current image. An image whose tag is in this set is never removed —
   * this is what keeps a build shared by another app's retained version safe.
   */
  retainedImageTags: Set<string>;
}

/**
 * Decides, for each app, which versions are retained (the newest N, always
 * including the current one) and which are pruned, and collects the global set
 * of image tags that must be protected. Pure and deterministic.
 */
export function planAppRetention(apps: AppRetentionInput[]): RetentionPlan {
  const perApp: AppRetentionDecision[] = [];
  const retainedImageTags = new Set<string>();

  for (const app of apps) {
    // The current image is always protected, even for a plain-image app with
    // no github deployments.
    if (app.currentImageTag) {
      retainedImageTags.add(app.currentImageTag);
    }

    const sorted = [...app.deployments].sort((a, b) => b.version - a.version);
    const keep = clampRetentionCount(app.retentionCount);

    const retainedVersions: number[] = [];
    const prunedVersions: { version: number; imageTag: string }[] = [];

    sorted.forEach((deployment, index) => {
      // Retain the newest `keep`, and unconditionally retain the current
      // version wherever it sits (defence in depth — the current version must
      // never be pruned).
      const retained = index < keep || deployment.isCurrent;
      if (retained) {
        retainedVersions.push(deployment.version);
        retainedImageTags.add(deployment.imageTag);
      } else {
        prunedVersions.push({ version: deployment.version, imageTag: deployment.imageTag });
      }
    });

    perApp.push({ appId: app.appId, retainedVersions, prunedVersions });
  }

  return { perApp, retainedImageTags };
}

export interface PruneImage {
  id: string;
  size: number;
  repoTags: string[];
  created: number;
}

function isDangling(image: PruneImage): boolean {
  return image.repoTags.length === 0 || image.repoTags.every((tag) => tag === "<none>:<none>");
}

function platformRepoOf(image: PruneImage): string | null {
  for (const tag of image.repoTags) {
    const repo = tag.split(":")[0];
    if (PLATFORM_IMAGE_REPOS.has(repo)) {
      return repo;
    }
  }
  return null;
}

export interface SelectSweepableInput {
  images: PruneImage[];
  /** Tags referenced by a retained ledger row or an app's current image. */
  referencedTags: ReadonlySet<string>;
  /** Image IDs used by ANY container (running or stopped). Never removed. */
  inUseImageIds: ReadonlySet<string>;
  /** How many newest platform images to keep per repo. */
  platformKeep: number;
  /** Current time in Unix seconds; defaults to now. Only used with minAgeSeconds. */
  now?: number;
  /**
   * Minimum image age, in seconds, before it may be swept. Guards against a
   * deploy that has just built its image but not yet recorded a ledger row or
   * created its container — that image would momentarily look orphaned. 0
   * (the default) disables the guard. The daily sweep passes a real value.
   */
  minAgeSeconds?: number;
}

/**
 * The daily safety-net selector. Returns images that are safe to remove even
 * though per-app ledger retention already ran:
 *
 *  - dangling (`<none>`) images left by rebuilds;
 *  - `deployment-app-<id>:*` images with NO referencing ledger row (orphans
 *    from a deploy that failed after building but before recording a version —
 *    the "deployment failed midway" case);
 *  - `deployment-platform-(api|web):*` images beyond the newest `platformKeep`
 *    per repo (the platform's own self-update history).
 *
 * An image used by any container, or whose tag is still referenced, is never
 * selected. Base images (nginx, postgres, …) are always left alone. Pure and
 * deterministic.
 */
export function selectSweepableImages(input: SelectSweepableInput): PruneImage[] {
  const { images, referencedTags, inUseImageIds } = input;
  const platformKeep = clampPlatformImageKeep(input.platformKeep);
  const minAgeSeconds = Math.max(0, input.minAgeSeconds ?? 0);
  const nowSeconds = input.now ?? Math.floor(Date.now() / 1000);

  const selected: PruneImage[] = [];
  const seen = new Set<string>();
  const platformByRepo = new Map<string, PruneImage[]>();

  function select(image: PruneImage): void {
    if (!seen.has(image.id)) {
      seen.add(image.id);
      selected.push(image);
    }
  }

  for (const image of images) {
    if (inUseImageIds.has(image.id)) {
      continue;
    }

    // A tag still referenced by the ledger (or an app's current image) pins the
    // whole image, regardless of its other tags.
    if (image.repoTags.some((tag) => referencedTags.has(tag))) {
      continue;
    }

    // Too fresh to be sure it isn't an in-flight build (see minAgeSeconds).
    if (minAgeSeconds > 0 && image.created > 0 && nowSeconds - image.created < minAgeSeconds) {
      continue;
    }

    if (isDangling(image)) {
      select(image);
      continue;
    }

    const platformRepo = platformRepoOf(image);
    if (platformRepo) {
      const list = platformByRepo.get(platformRepo) ?? [];
      list.push(image);
      platformByRepo.set(platformRepo, list);
      continue;
    }

    // An orphaned per-app build image (no referencing version) — never in the
    // ledger, so safe to reclaim.
    if (image.repoTags.some((tag) => DEPLOYMENT_APP_TAG.test(tag))) {
      select(image);
    }
    // Anything else (base images) is intentionally left alone.
  }

  for (const list of platformByRepo.values()) {
    list.sort((a, b) => b.created - a.created);
    for (const image of list.slice(platformKeep)) {
      select(image);
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Docker operations (the impure boundary)
// ---------------------------------------------------------------------------

export interface RetentionContainer {
  id: string;
  /** Names with any leading slash stripped. */
  names: string[];
  imageId: string;
  managed: boolean;
  running: boolean;
}

export interface RetentionDockerOps {
  listContainers(): Promise<RetentionContainer[]>;
  listImages(): Promise<PruneImage[]>;
  /** Removes an image by tag (or id). Untags when other tags remain; frees the image when it's the last reference. */
  removeImageByTag(tag: string): Promise<void>;
  /** Removes a container by name or id. Resolves even if it's already gone. */
  removeContainer(nameOrId: string): Promise<void>;
}

export function createRetentionDockerOps(docker: Docker): RetentionDockerOps {
  return {
    async listContainers() {
      const containers = await docker.listContainers({ all: true });
      return containers.map((container) => ({
        id: container.Id,
        names: (container.Names ?? []).map((name) => name.replace(/^\//, "")),
        imageId: container.ImageID,
        managed: (container.Labels ?? {})["com.deployment-platform.managed"] === "true",
        running: container.State === "running"
      }));
    },
    async listImages() {
      const images = await docker.listImages();
      return images.map((image) => ({
        id: image.Id,
        size: image.Size ?? 0,
        repoTags: image.RepoTags ?? [],
        created: image.Created ?? 0
      }));
    },
    async removeImageByTag(tag) {
      await docker.getImage(tag).remove();
    },
    async removeContainer(nameOrId) {
      try {
        await docker.getContainer(nameOrId).remove({ force: true });
      } catch (error) {
        if (getErrorStatusCode(error) !== 404) {
          throw error;
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Runners (never throw — failures are collected, not propagated)
// ---------------------------------------------------------------------------

export interface RetentionLogger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface RetentionDeps {
  appDatabase: AppDatabase;
  dockerOps: RetentionDockerOps;
  config: RetentionConfig;
  logger?: RetentionLogger;
  now?: () => number;
}

export interface RetentionCleanupResult {
  scope: "app" | "global";
  appId: number | null;
  /** True when a cleanup was skipped because a deployment held the lock. */
  skipped: boolean;
  versionsPruned: number;
  imagesDeleted: number;
  imagesRetained: number;
  containersRemoved: number;
  bytesReclaimed: number;
  durationMs: number;
  failures: string[];
}

const LEFTOVER_CONTAINER_SUFFIX = /-(rollback|github-deploy|redeploy)-/;
/** Freshly-built images are protected from the daily sweep for this long (1 hour). */
const SWEEP_MIN_IMAGE_AGE_SECONDS = 60 * 60;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptyResult(scope: "app" | "global", appId: number | null): RetentionCleanupResult {
  return {
    scope,
    appId,
    skipped: false,
    versionsPruned: 0,
    imagesDeleted: 0,
    imagesRetained: 0,
    containersRemoved: 0,
    bytesReclaimed: 0,
    durationMs: 0,
    failures: []
  };
}

function mergeInto(target: RetentionCleanupResult, source: RetentionCleanupResult): void {
  target.versionsPruned += source.versionsPruned;
  target.imagesDeleted += source.imagesDeleted;
  target.imagesRetained += source.imagesRetained;
  target.containersRemoved += source.containersRemoved;
  target.bytesReclaimed += source.bytesReclaimed;
  target.failures.push(...source.failures);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** Builds the per-app retention inputs for the whole platform from the DB. */
function buildAppInputs(appDatabase: AppDatabase, globalCount: number): AppRetentionInput[] {
  const deploymentsByApp = new Map<number, RetentionDeployment[]>();
  for (const deployment of appDatabase.listAllGithubDeployments()) {
    const list = deploymentsByApp.get(deployment.appId) ?? [];
    list.push({ version: deployment.version, imageTag: deployment.imageTag, isCurrent: deployment.isCurrent });
    deploymentsByApp.set(deployment.appId, list);
  }

  return appDatabase.listApps().map((app) => ({
    appId: app.id,
    currentImageTag: app.image,
    retentionCount: resolveRetentionCount(app, globalCount),
    deployments: deploymentsByApp.get(app.id) ?? []
  }));
}

/**
 * The core, lock-free single-app cleanup. The caller is responsible for
 * ensuring no deployment for this app runs concurrently (deployFromGithub
 * calls this while it holds the per-app deployment lock; the locked wrappers
 * below acquire it first). Never throws.
 */
export async function cleanupAppRetention(
  deps: RetentionDeps,
  appId: number
): Promise<RetentionCleanupResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const result = emptyResult("app", appId);

  try {
    const app = deps.appDatabase.getAppById(appId);
    if (!app || !app.containerName) {
      return result;
    }

    const globalCount = clampRetentionCount(deps.config.count);
    const plan = planAppRetention(buildAppInputs(deps.appDatabase, globalCount));
    const decision = plan.perApp.find((entry) => entry.appId === appId);

    if (decision) {
      result.imagesRetained = decision.retainedVersions.length;
    }

    // A single container listing serves both the in-use image guard and the
    // leftover-container sweep.
    const containers = await deps.dockerOps.listContainers();

    if (decision && decision.prunedVersions.length > 0) {
      const images = await deps.dockerOps.listImages();
      const tagToImage = new Map<string, PruneImage>();
      const retainedImageIds = new Set<string>();
      for (const image of images) {
        for (const tag of image.repoTags) {
          tagToImage.set(tag, image);
          if (plan.retainedImageTags.has(tag)) {
            retainedImageIds.add(image.id);
          }
        }
      }

      const inUseImageIds = new Set(containers.map((container) => container.imageId));
      const reclaimedIds = new Set<string>();
      const prunedVersionNumbers: number[] = [];

      for (const pruned of decision.prunedVersions) {
        // Always drop the ledger row for a beyond-retention version so the
        // History UI only ever shows retained versions.
        prunedVersionNumbers.push(pruned.version);

        // The image is removed only when nothing references it: its tag isn't
        // retained (this app or any other), its id isn't backing a retained
        // tag, and no container uses it.
        if (plan.retainedImageTags.has(pruned.imageTag)) {
          continue;
        }
        const image = tagToImage.get(pruned.imageTag);
        if (!image) {
          continue; // already gone — the row deletion below is enough.
        }
        if (inUseImageIds.has(image.id) || retainedImageIds.has(image.id)) {
          continue;
        }

        try {
          await deps.dockerOps.removeImageByTag(pruned.imageTag);
          if (!reclaimedIds.has(image.id)) {
            reclaimedIds.add(image.id);
            result.imagesDeleted += 1;
            result.bytesReclaimed += image.size;
          }
        } catch (error) {
          result.failures.push(`remove image ${pruned.imageTag}: ${errorText(error)}`);
        }
      }

      try {
        result.versionsPruned = deps.appDatabase.deleteDeployments(appId, prunedVersionNumbers);
      } catch (error) {
        result.failures.push(`delete ledger rows for app ${appId}: ${errorText(error)}`);
      }
    }

    // Sweep leftover rollback/temp containers for this app. The live container
    // (named exactly app.containerName) and anything still running are never
    // touched, so a concurrent deploy's running replacement is safe.
    const leftoverPattern = new RegExp(`^${escapeRegExp(app.containerName)}${LEFTOVER_CONTAINER_SUFFIX.source}`);
    for (const container of containers) {
      if (!container.managed || container.running) {
        continue;
      }
      if (container.names.includes(app.containerName)) {
        continue;
      }
      if (!container.names.some((name) => leftoverPattern.test(name))) {
        continue;
      }
      try {
        await deps.dockerOps.removeContainer(container.id);
        result.containersRemoved += 1;
      } catch (error) {
        result.failures.push(`remove container ${container.names[0] ?? container.id}: ${errorText(error)}`);
      }
    }
  } catch (error) {
    // Never let cleanup throw — a deployment must still succeed.
    result.failures.push(`app retention: ${errorText(error)}`);
  }

  result.durationMs = now() - startedAt;
  return result;
}

/**
 * Single-app cleanup guarded by the per-app deployment lock. Used by paths that
 * do NOT already hold the lock (revert). If a deployment is in progress the
 * cleanup is skipped — that deployment will clean up when it finishes.
 */
export async function cleanupAppRetentionLocked(
  deps: RetentionDeps,
  appId: number
): Promise<RetentionCleanupResult> {
  if (!deps.appDatabase.acquireDeploymentLock(appId)) {
    return { ...emptyResult("app", appId), skipped: true };
  }
  try {
    return await cleanupAppRetention(deps, appId);
  } finally {
    deps.appDatabase.releaseDeploymentLock(appId);
  }
}

/**
 * The daily safety net: run the locked single-app cleanup for every app, then
 * a global image sweep (dangling + orphaned per-app builds + old platform
 * images). Never throws; returns one aggregated summary.
 */
export async function runGlobalSweep(deps: RetentionDeps): Promise<RetentionCleanupResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const result = emptyResult("global", null);

  try {
    for (const app of deps.appDatabase.listApps()) {
      if (!app.containerName) {
        continue;
      }
      const appResult = await cleanupAppRetentionLocked(deps, app.id);
      if (!appResult.skipped) {
        mergeInto(result, appResult);
      }
    }

    // Global image sweep, computed against the ledger AFTER per-app cleanup.
    const [images, containers] = await Promise.all([
      deps.dockerOps.listImages(),
      deps.dockerOps.listContainers()
    ]);
    const inUseImageIds = new Set(containers.map((container) => container.imageId));
    const referencedTags = new Set<string>();
    for (const deployment of deps.appDatabase.listAllGithubDeployments()) {
      referencedTags.add(deployment.imageTag);
    }
    for (const app of deps.appDatabase.listApps()) {
      referencedTags.add(app.image);
    }

    const sweepable = selectSweepableImages({
      images,
      referencedTags,
      inUseImageIds,
      platformKeep: clampPlatformImageKeep(deps.config.platformImageKeep),
      // Never reclaim an image built in the last hour — it may belong to a
      // deploy that is mid-flight and hasn't recorded its ledger row yet.
      now: Math.floor(now() / 1000),
      minAgeSeconds: SWEEP_MIN_IMAGE_AGE_SECONDS
    });

    const reclaimedIds = new Set<string>();
    for (const image of sweepable) {
      const ref = image.repoTags.find((tag) => tag !== "<none>:<none>") ?? image.id;
      try {
        await deps.dockerOps.removeImageByTag(ref);
        if (!reclaimedIds.has(image.id)) {
          reclaimedIds.add(image.id);
          result.imagesDeleted += 1;
          result.bytesReclaimed += image.size;
        }
      } catch (error) {
        result.failures.push(`sweep image ${ref}: ${errorText(error)}`);
      }
    }
  } catch (error) {
    result.failures.push(`global sweep: ${errorText(error)}`);
  }

  result.durationMs = now() - startedAt;

  deps.logger?.info(
    {
      imagesDeleted: result.imagesDeleted,
      containersRemoved: result.containersRemoved,
      bytesReclaimed: result.bytesReclaimed,
      imagesRetained: result.imagesRetained,
      versionsPruned: result.versionsPruned,
      durationMs: result.durationMs,
      failures: result.failures.length
    },
    "Deployment retention sweep completed"
  );

  return result;
}
