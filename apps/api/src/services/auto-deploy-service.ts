import type { AppDatabase, AutoDeployCandidate } from "../database.js";

export interface AutoDeployLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface AutoDeploySchedulerOptions {
  appDatabase: AppDatabase;
  /**
   * Resolves the current HEAD commit SHA of a candidate's branch, or null if
   * it can't be determined right now (no credential, transient GitHub error).
   * Injected so the scheduler can be tested without real GitHub access.
   */
  resolveBranchHead: (candidate: AutoDeployCandidate) => Promise<string | null>;
  /** Kicks off a GitHub deployment for the app (deployFromGithub in production). */
  triggerDeploy: (appId: number) => Promise<void>;
  logger: AutoDeployLogger;
  /** How often to poll. Defaults to 60s. */
  intervalMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface AutoDeployScheduler {
  start: () => void;
  stop: () => void;
  /** Runs a single poll pass. Exposed for tests and for the start() tick. */
  runOnce: () => Promise<void>;
}

/** Only Dockerfile/prebuilt sources with a resolved repo can be auto-deployed. */
function isDeployable(candidate: AutoDeployCandidate): boolean {
  return Boolean(candidate.repositoryOwner) && Boolean(candidate.repositoryName);
}

export function createAutoDeployScheduler(options: AutoDeploySchedulerOptions): AutoDeployScheduler {
  const intervalMs = options.intervalMs ?? 60_000;
  const setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle) => clearInterval(handle as unknown as NodeJS.Timeout));

  const inFlight = new Set<number>();
  let timerHandle: unknown = null;

  async function considerCandidate(candidate: AutoDeployCandidate): Promise<void> {
    if (!isDeployable(candidate)) {
      return;
    }

    // Skip anything already deploying — either from a previous auto-deploy
    // tick still running, or a manual deploy the user just kicked off.
    if (inFlight.has(candidate.appId) || options.appDatabase.isDeploymentLocked(candidate.appId)) {
      return;
    }

    let head: string | null;
    try {
      head = await options.resolveBranchHead(candidate);
    } catch (error) {
      options.logger.warn(
        { appId: candidate.appId, error: error instanceof Error ? error.message : "unknown" },
        "Auto-deploy could not resolve the branch head"
      );
      return;
    }

    if (!head || head === candidate.latestDeployedCommitSha) {
      return;
    }

    inFlight.add(candidate.appId);
    options.logger.info(
      { appId: candidate.appId, head: head.slice(0, 12) },
      "Auto-deploy detected a new commit; deploying"
    );

    try {
      await options.triggerDeploy(candidate.appId);
    } catch (error) {
      options.logger.error(
        { appId: candidate.appId, error: error instanceof Error ? error.message : "unknown" },
        "Auto-deploy trigger failed"
      );
    } finally {
      inFlight.delete(candidate.appId);
    }
  }

  async function runOnce(): Promise<void> {
    let candidates: AutoDeployCandidate[];
    try {
      candidates = options.appDatabase.listAutoDeploySources();
    } catch (error) {
      options.logger.error(
        { error: error instanceof Error ? error.message : "unknown" },
        "Auto-deploy scheduler failed to list candidates"
      );
      return;
    }

    // Sequential rather than parallel: keeps GitHub API pressure low and
    // avoids a burst of simultaneous builds on a small host.
    for (const candidate of candidates) {
      await considerCandidate(candidate);
    }
  }

  return {
    runOnce,
    start() {
      if (timerHandle !== null) {
        return;
      }
      timerHandle = setIntervalFn(() => {
        void runOnce();
      }, intervalMs);
    },
    stop() {
      if (timerHandle !== null) {
        clearIntervalFn(timerHandle);
        timerHandle = null;
      }
    }
  };
}
