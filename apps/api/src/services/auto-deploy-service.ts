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
  /**
   * Kicks off a GitHub deployment for the app (deployFromGithub in
   * production). Resolves true when the deploy succeeded, false when it
   * failed. Crucial for the circuit breaker: a failed deploy leaves the
   * app's deployed-commit unchanged, so without knowing it failed the
   * scheduler would re-attempt the SAME broken commit on every tick
   * forever.
   */
  triggerDeploy: (appId: number) => Promise<boolean>;
  logger: AutoDeployLogger;
  /** How often to poll. Defaults to 60s. */
  intervalMs?: number;
  /**
   * How many times the same commit may fail to auto-deploy before the
   * breaker opens and stops retrying it. A fresh commit resets the count.
   * Defaults to 3.
   */
  maxConsecutiveFailures?: number;
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
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  const setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn =
    options.clearIntervalFn ?? ((handle) => clearInterval(handle as unknown as NodeJS.Timeout));

  const inFlight = new Set<number>();

  /**
   * Per-app circuit breaker. A build failure leaves the deployed-commit
   * unchanged, so the naive scheduler re-attempts the same broken commit on
   * every tick — the tight retry loop that floods the Activity log. This
   * records the failing commit and its failure count; once a commit has
   * failed `maxConsecutiveFailures` times the breaker is open and that
   * commit is skipped until it changes (a new push) or the app is deployed
   * successfully by hand. In-memory by design: a fresh process rightly
   * gives every app one more try.
   */
  const breaker = new Map<number, { commitSha: string; failures: number }>();

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

    // A new commit clears any breaker recorded against an older one — the
    // fix might be in this push, so it deserves a fresh set of attempts.
    const tripped = breaker.get(candidate.appId);
    if (tripped && tripped.commitSha !== head) {
      breaker.delete(candidate.appId);
    }

    // Breaker open for THIS commit: stop retrying it. Logged once, at the
    // moment it opens (below), never on every subsequent silent skip.
    const current = breaker.get(candidate.appId);
    if (current && current.commitSha === head && current.failures >= maxConsecutiveFailures) {
      return;
    }

    inFlight.add(candidate.appId);
    options.logger.info(
      { appId: candidate.appId, head: head.slice(0, 12) },
      "Auto-deploy detected a new commit; deploying"
    );

    try {
      const succeeded = await options.triggerDeploy(candidate.appId);

      if (succeeded) {
        breaker.delete(candidate.appId);
        return;
      }

      recordFailure(candidate.appId, head);
    } catch (error) {
      // A thrown error is a failure too — count it toward the breaker so a
      // deploy that keeps throwing can't loop forever either.
      options.logger.error(
        { appId: candidate.appId, error: error instanceof Error ? error.message : "unknown" },
        "Auto-deploy trigger failed"
      );
      recordFailure(candidate.appId, head);
    } finally {
      inFlight.delete(candidate.appId);
    }
  }

  function recordFailure(appId: number, commitSha: string): void {
    const existing = breaker.get(appId);
    const failures = existing && existing.commitSha === commitSha ? existing.failures + 1 : 1;
    breaker.set(appId, { commitSha, failures });

    if (failures >= maxConsecutiveFailures) {
      options.logger.warn(
        { appId, commit: commitSha.slice(0, 12), failures },
        "Auto-deploy is pausing retries for this commit after repeated failures; it will resume when a new commit is pushed or a manual deploy succeeds"
      );
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
