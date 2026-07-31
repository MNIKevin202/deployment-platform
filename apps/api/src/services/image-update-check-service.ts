import type Docker from "dockerode";
import { getErrorStatusCode } from "../docker-errors.js";

/**
 * Periodically checks every plain-image app (a template deploy — Postgres,
 * Redis, Quipora IRC/Bot, etc. — anything with no app_sources row) for
 * whether its registry image has moved past what's currently running, so
 * the panel can show a "redeploy to update" indicator without the user
 * having to remember to check manually.
 *
 * Detection reuses the same docker.pull() + image inspect calls the
 * redeploy pipeline already makes (see redeploy-service.ts) — Docker
 * itself handles registry auth exactly as it does for a real deploy, so
 * there's no per-registry API to implement here. A pull that yields the
 * same local image ID the running container already has means "already
 * current"; a different ID means an update landed in the registry.
 */

export interface ImageUpdateStatus {
  updateAvailable: boolean;
  checkedAt: string;
}

export interface ImageUpdateCheckApp {
  id: number;
  containerId: string | null;
  image: string;
}

/**
 * The narrow slice of Docker operations a check needs — kept separate from
 * the dockerode client so the scheduler's logic can be unit tested with a
 * plain fake, matching the style of RedeployDockerOps.
 */
export interface ImageUpdateCheckDockerOps {
  /** The image ID (Docker's internal Id, e.g. "sha256:...") a running container was created from. */
  inspectContainerImageId(containerId: string): Promise<string | null>;
  /** Pulls the image's tag from its registry, updating the local copy if it moved. */
  pullImage(image: string): Promise<void>;
  /** The local image ID for a tag, after a pull. */
  inspectImageId(image: string): Promise<string | null>;
}

export interface ImageUpdateCheckLogger {
  error: (obj: unknown, msg?: string) => void;
}

export interface ImageUpdateCheckerOptions {
  listCandidateApps: () => ImageUpdateCheckApp[];
  /** True for apps built from a GitHub source repo — excluded, they have their own auto-deploy. */
  hasAppSource: (appId: number) => boolean;
  dockerOps: ImageUpdateCheckDockerOps;
  logger: ImageUpdateCheckLogger;
  /** How often to check. Defaults to hourly. */
  tickIntervalMs?: number;
  now?: () => Date;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface ImageUpdateChecker {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<void>;
  getStatus: (appId: number) => ImageUpdateStatus | null;
}

export function createImageUpdateCheckDockerOps(docker: Docker): ImageUpdateCheckDockerOps {
  return {
    async inspectContainerImageId(containerId) {
      try {
        const details = await docker.getContainer(containerId).inspect();
        return details.Image;
      } catch (error) {
        if (getErrorStatusCode(error) === 404) {
          return null;
        }
        throw error;
      }
    },

    async pullImage(image) {
      const stream = await docker.pull(image);

      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },

    async inspectImageId(image) {
      try {
        const details = await docker.getImage(image).inspect();
        return details.Id;
      } catch (error) {
        if (getErrorStatusCode(error) === 404) {
          return null;
        }
        throw error;
      }
    }
  };
}

export function createImageUpdateChecker(options: ImageUpdateCheckerOptions): ImageUpdateChecker {
  const tickIntervalMs = options.tickIntervalMs ?? 60 * 60 * 1000;
  const now = options.now ?? (() => new Date());
  const setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle) => clearInterval(handle as unknown as NodeJS.Timeout));

  const statusByAppId = new Map<number, ImageUpdateStatus>();
  let timerHandle: unknown = null;
  let inFlight = false;

  async function checkApp(app: ImageUpdateCheckApp): Promise<void> {
    if (!app.containerId) {
      return;
    }

    try {
      const runningImageId = await options.dockerOps.inspectContainerImageId(app.containerId);
      if (!runningImageId) {
        return;
      }

      await options.dockerOps.pullImage(app.image);
      const latestImageId = await options.dockerOps.inspectImageId(app.image);
      if (!latestImageId) {
        return;
      }

      statusByAppId.set(app.id, {
        updateAvailable: latestImageId !== runningImageId,
        checkedAt: now().toISOString()
      });
    } catch (error) {
      options.logger.error(
        { appId: app.id, image: app.image, error: error instanceof Error ? error.message : "unknown" },
        "Image update check failed for app"
      );
    }
  }

  async function runOnce(): Promise<void> {
    if (inFlight) {
      return;
    }

    inFlight = true;
    try {
      const candidates = options.listCandidateApps().filter((app) => !options.hasAppSource(app.id));
      for (const app of candidates) {
        await checkApp(app);
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    runOnce,
    getStatus(appId) {
      return statusByAppId.get(appId) ?? null;
    },
    start() {
      if (timerHandle !== null) {
        return;
      }
      timerHandle = setIntervalFn(() => {
        void runOnce();
      }, tickIntervalMs);
    },
    stop() {
      if (timerHandle !== null) {
        clearIntervalFn(timerHandle);
        timerHandle = null;
      }
    }
  };
}
