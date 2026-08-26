import type { AppDatabase } from "../database.js";
import type { RecordEventFn } from "./deployment-event-service.js";
import {
  redeployApp,
  errorMessage,
  type RedeployDockerOps,
  type RedeployReconcileResult
} from "./redeploy-service.js";
import type { RetentionCleanupResult } from "./deployment-retention-service.js";

/**
 * Reverting re-runs a past version's retained image. It needs everything a
 * redeploy needs, plus `imageExists` to confirm the target build is still
 * present on the host before touching the running container.
 */
export interface RevertDockerOps extends RedeployDockerOps {
  imageExists(tag: string): Promise<boolean>;
}

export interface RevertDependencies {
  appDatabase: AppDatabase;
  dockerOps: RevertDockerOps;
  reconcileRouting: (appDatabase: AppDatabase) => Promise<RedeployReconcileResult>;
  recordEvent: RecordEventFn;
  /**
   * Best-effort retention cleanup, run after a successful revert (a revert
   * appends a new version and can push an older one out of the keep window).
   * This must be the lock-guarded variant, since a revert does not hold the
   * deployment lock. Optional; a failure never affects the revert result.
   */
  cleanupRetention?: (appId: number) => Promise<RetentionCleanupResult>;
  now?: () => Date;
}

export interface RevertResult {
  success: boolean;
  message: string;
  /** The new version appended by a successful revert. */
  newVersion?: number;
}

/**
 * Reverts an app to an earlier version by re-running that version's retained
 * image, then appending a *new* version that records the revert (CapRover
 * style) rather than mutating history.
 *
 * Only GitHub-built versions can be reverted to: they alone have a retained,
 * per-commit `deployment-app-<id>:<sha>` image. Plain image apps run whatever
 * their tag currently resolves to and keep a current-only history.
 *
 * The actual container swap reuses `redeployApp` (with the target image and
 * pull skipped, since the image is local), so the revert inherits its
 * build-new-then-swap safety: a failure never leaves the app worse off than
 * before.
 */
export async function revertToDeployment(
  deps: RevertDependencies,
  appId: number,
  version: number
): Promise<RevertResult> {
  const deployStartedAtMs = Date.now();
  const { appDatabase, dockerOps, reconcileRouting, recordEvent } = deps;
  const now = deps.now ?? (() => new Date());

  const app = appDatabase.getAppById(appId);

  if (!app) {
    return { success: false, message: "App not found" };
  }

  const target = appDatabase.getDeployment(appId, version);

  if (!target) {
    return { success: false, message: `Version ${version} was not found for this app` };
  }

  if (target.sourceKind !== "github") {
    return {
      success: false,
      message: "Only GitHub-deployed versions can be reverted to."
    };
  }

  if (target.isCurrent) {
    return {
      success: false,
      message: `Version ${version} is already the current deployment.`
    };
  }

  let imagePresent: boolean;
  try {
    imagePresent = await dockerOps.imageExists(target.imageTag);
  } catch (error) {
    return {
      success: false,
      message: `Unable to check whether the image for version ${version} is available: ${errorMessage(error)}`
    };
  }

  if (!imagePresent) {
    return {
      success: false,
      message: `The image for version ${version} is no longer available on the host, so it cannot be restored.`
    };
  }

  recordEvent({
    appId,
    eventType: "revert-started",
    severity: "info",
    message: `Reverting "${app.name}" to version ${version}`,
    metadata: { targetVersion: version, imageTag: target.imageTag }
  });

  const result = await redeployApp(
    { appDatabase, dockerOps, reconcileRouting, recordEvent },
    appId,
    { imageOverride: target.imageTag, skipPull: true, recordHistory: false }
  );

  if (!result.success) {
    // redeployApp already recorded a redeploy-failed event and left the
    // existing container untouched (or precisely reported any partial
    // state). Surface its message as the revert failure.
    recordEvent({
      appId,
      eventType: "revert-failed",
      severity: "error",
      message: `Revert of "${app.name}" to version ${version} failed: ${result.message}`,
      metadata: { targetVersion: version }
    });

    return { success: false, message: result.message };
  }

  // The revert is live. Point the app's stored image at the restored build so
  // a later plain redeploy stays consistent, refresh the deployed-commit
  // bookkeeping, and append a new current version marking the revert.
  appDatabase.updateAppImage(appId, target.imageTag);

  if (target.commitSha) {
    try {
      appDatabase.updateDeployedCommit(appId, {
        commitSha: target.commitSha,
        commitMessage: target.commitMessage,
        deployedAt: now().toISOString()
      });
    } catch {
      // A revert target is always GitHub-sourced, so a source row should
      // exist; if it somehow doesn't, the container swap still succeeded,
      // so don't fail the revert over bookkeeping.
    }
  }

  const recorded = appDatabase.recordDeployment({
    appId,
    imageTag: target.imageTag,
    commitSha: target.commitSha,
    commitMessage: target.commitMessage,
    sourceKind: "github",
    revertOfVersion: version,
    durationMs: Math.max(0, Date.now() - deployStartedAtMs)
  });

  recordEvent({
    appId,
    eventType: "revert-succeeded",
    severity: "info",
    message: `Reverted "${app.name}" to version ${version} (now version ${recorded.version})`,
    metadata: { targetVersion: version, newVersion: recorded.version, imageTag: target.imageTag }
  });

  // Best-effort: a revert appended a new version, which may push an old one
  // beyond the keep window. Never throws (the runner collects failures) and
  // never affects the revert result.
  if (deps.cleanupRetention) {
    try {
      await deps.cleanupRetention(appId);
    } catch {
      // Deliberately swallowed — the revert already succeeded.
    }
  }

  return {
    success: true,
    message: `Reverted to version ${version}. This is now version ${recorded.version}.`,
    newVersion: recorded.version
  };
}
