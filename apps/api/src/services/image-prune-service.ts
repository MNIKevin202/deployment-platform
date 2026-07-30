import type Docker from "dockerode";

export interface PruneImage {
  id: string;
  size: number;
  repoTags: string[];
  created: number;
}

/** Matches the per-app build image tag `deployment-app-<id>:<sha>`. */
const BUILD_IMAGE_TAG = /^deployment-app-(\d+):/;

function isDangling(image: PruneImage): boolean {
  return image.repoTags.length === 0 || image.repoTags.every((tag) => tag === "<none>:<none>");
}

/** The app id a build image belongs to, or null if it isn't a build image. */
function buildImageAppId(image: PruneImage): number | null {
  for (const tag of image.repoTags) {
    const match = BUILD_IMAGE_TAG.exec(tag);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

/**
 * Chooses which images are safe to remove: every dangling (`<none>`) image,
 * plus per-app build images beyond the newest `keepPerApp` for each app.
 * Images currently used by a container are never selected, and non-build
 * images (base images like `nginx:alpine`) are always left alone. Pure and
 * deterministic so it can be unit-tested without Docker.
 */
export function selectPrunableImages(
  images: PruneImage[],
  inUseImageIds: ReadonlySet<string>,
  keepPerApp: number
): PruneImage[] {
  const keep = Math.max(0, Math.floor(keepPerApp));
  const candidates: PruneImage[] = [];
  const seen = new Set<string>();

  const buildImagesByApp = new Map<number, PruneImage[]>();

  for (const image of images) {
    if (inUseImageIds.has(image.id)) {
      continue;
    }

    if (isDangling(image)) {
      if (!seen.has(image.id)) {
        seen.add(image.id);
        candidates.push(image);
      }
      continue;
    }

    const appId = buildImageAppId(image);
    if (appId !== null) {
      const list = buildImagesByApp.get(appId) ?? [];
      list.push(image);
      buildImagesByApp.set(appId, list);
    }
  }

  for (const list of buildImagesByApp.values()) {
    // Newest first; keep the first `keep`, prune the remainder.
    list.sort((a, b) => b.created - a.created);
    for (const image of list.slice(keep)) {
      if (!seen.has(image.id)) {
        seen.add(image.id);
        candidates.push(image);
      }
    }
  }

  return candidates;
}

export interface ImagePruneDockerOps {
  listImages(): Promise<PruneImage[]>;
  listInUseImageIds(): Promise<ReadonlySet<string>>;
  removeImage(id: string): Promise<void>;
}

export function createImagePruneDockerOps(docker: Docker): ImagePruneDockerOps {
  return {
    async listImages() {
      const images = await docker.listImages();
      return images.map((image) => ({
        id: image.Id,
        size: image.Size ?? 0,
        repoTags: image.RepoTags ?? [],
        created: image.Created ?? 0
      }));
    },
    async listInUseImageIds() {
      const containers = await docker.listContainers({ all: true });
      return new Set(containers.map((container) => container.ImageID));
    },
    async removeImage(id) {
      await docker.getImage(id).remove();
    }
  };
}

export interface PrunePreview {
  candidates: number;
  reclaimableBytes: number;
}

export async function previewImagePrune(
  ops: ImagePruneDockerOps,
  keepPerApp: number
): Promise<PrunePreview> {
  const [images, inUse] = await Promise.all([ops.listImages(), ops.listInUseImageIds()]);
  const candidates = selectPrunableImages(images, inUse, keepPerApp);
  return {
    candidates: candidates.length,
    reclaimableBytes: candidates.reduce((sum, image) => sum + image.size, 0)
  };
}

export interface PruneResult {
  removed: number;
  reclaimedBytes: number;
  failed: number;
}

export async function pruneImages(
  ops: ImagePruneDockerOps,
  keepPerApp: number
): Promise<PruneResult> {
  const [images, inUse] = await Promise.all([ops.listImages(), ops.listInUseImageIds()]);
  const candidates = selectPrunableImages(images, inUse, keepPerApp);

  let removed = 0;
  let reclaimedBytes = 0;
  let failed = 0;

  for (const image of candidates) {
    try {
      await ops.removeImage(image.id);
      removed += 1;
      reclaimedBytes += image.size;
    } catch {
      // A layer may be shared or the image may have become in-use since the
      // listing — skip it rather than failing the whole prune.
      failed += 1;
    }
  }

  return { removed, reclaimedBytes, failed };
}
