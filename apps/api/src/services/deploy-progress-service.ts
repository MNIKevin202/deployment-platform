import type { DeployStage } from "./github-deploy-service.js";

/**
 * Live progress for a GitHub deployment, so the panel can show a real
 * progress bar instead of leaving an operator staring at a page that says
 * "Building image" for five minutes with no sign of life.
 *
 * Everything here is derived from signals the deploy pipeline ALREADY
 * emits — the ordered stage callbacks in github-deploy-service, and
 * Docker's own "Step X/Y" lines from the build stream. Nothing new is
 * measured or estimated out of thin air:
 *
 *   - stage transitions give a coarse floor (cloning is further along than
 *     resolving, starting is further along than building);
 *   - within the build — by far the longest stage — Docker's step counter
 *     gives a genuine fraction;
 *   - the time estimate is elapsed/fraction, and is withheld entirely
 *     until the fraction is meaningful rather than shown as a guess.
 *
 * State is in-memory, like install-progress-service and the model-pull
 * tracker: a deployment lasts one request, and after an API restart the
 * honest answer is "nothing is deploying". The durable record of what
 * happened remains the deployment events and build logs.
 */

/**
 * Where each stage ENDS on a 0–100 scale. Building dominates because it
 * dominates real elapsed time — cloning a repo and renaming a container
 * are seconds; a Docker build on a small VPS is minutes.
 */
export const DEPLOY_STAGE_CEILINGS: Record<DeployStage, number> = {
  "resolving-repository": 3,
  "resolving-branch": 5,
  "reading-commit-metadata": 7,
  "preparing-checkout": 9,
  "cloning-repository": 14,
  "inspecting-project": 17,
  "preparing-build": 20,
  "building-image": 80,
  "preserving-current-container": 84,
  "starting-replacement": 90,
  "verifying-health": 95,
  "updating-route": 98,
  "cleaning-temporary-files": 99,
  "deployment-complete": 100
};

export const DEPLOY_STAGE_LABELS: Record<DeployStage, string> = {
  "resolving-repository": "Resolving repository",
  "resolving-branch": "Resolving branch",
  "reading-commit-metadata": "Reading commit metadata",
  "preparing-checkout": "Preparing checkout",
  "cloning-repository": "Cloning repository",
  "inspecting-project": "Inspecting project",
  "preparing-build": "Preparing build",
  "building-image": "Building image",
  "preserving-current-container": "Preserving current container",
  "starting-replacement": "Starting replacement",
  "verifying-health": "Verifying health",
  "updating-route": "Updating route",
  "cleaning-temporary-files": "Cleaning up",
  "deployment-complete": "Deployed"
};

/** The stage the build steps live in, and where its band starts. */
const BUILD_BAND_START = DEPLOY_STAGE_CEILINGS["preparing-build"];
const BUILD_BAND_END = DEPLOY_STAGE_CEILINGS["building-image"];

export type DeployProgressStatus = "running" | "succeeded" | "failed";

export interface DeployProgress {
  appId: number;
  appName: string;
  /** e.g. "MNIKevin202/Staxxio@main" — shown under the app name. */
  source: string | null;
  status: DeployProgressStatus;
  stage: DeployStage;
  stageLabel: string;
  /** 0–100 across the whole deployment. */
  percent: number;
  /** Docker build step counter, when the build has reported one. */
  step: number | null;
  totalSteps: number | null;
  /** Free-text detail for the current stage. */
  detail: string;
  startedAt: string;
  finishedAt: string | null;
  /** Seconds remaining, or null while not yet meaningfully estimable. */
  etaSeconds: number | null;
  /** Present only when status is "failed". */
  error: string | null;
  /** The stage that failed, for a precise failure message. */
  failedStage: DeployStage | null;
  /** True when the pipeline restored the previous container. */
  rolledBack: boolean;
}

/**
 * Parses Docker's build-stream step counter. The classic builder emits
 * lines like "Step 7/14 : RUN npm ci". Returns null for any other line, so
 * ordinary build output never disturbs the counter.
 */
export function parseBuildStep(line: string): { step: number; total: number } | null {
  const match = /^\s*Step\s+(\d+)\/(\d+)\s*:/m.exec(line);

  if (!match) {
    return null;
  }

  const step = Number(match[1]);
  const total = Number(match[2]);

  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0 || step < 0) {
    return null;
  }

  return { step, total: Math.max(total, step) };
}

/**
 * Percentage for a deployment, given its stage and (inside the build) how
 * far through the Docker steps it is. Pure, so the weighting is directly
 * testable.
 */
export function deployPercent(
  stage: DeployStage,
  step: number | null,
  totalSteps: number | null
): number {
  if (stage === "building-image") {
    // Entering the build sits at the FLOOR of its band, not the ceiling —
    // the ceiling means "the build finished". Returning the ceiling here
    // would peg the bar at 80% the instant building started, leaving the
    // step counter unable to move it (the no-going-backwards rule would
    // discard every later, smaller value) — i.e. exactly the frozen bar
    // this overlay exists to avoid.
    if (step === null || !totalSteps || totalSteps <= 0) {
      return BUILD_BAND_START;
    }

    const fraction = Math.min(1, step / totalSteps);
    return Math.round(BUILD_BAND_START + (BUILD_BAND_END - BUILD_BAND_START) * fraction);
  }

  return DEPLOY_STAGE_CEILINGS[stage];
}

/**
 * Seconds remaining, extrapolated from how long the work so far took.
 *
 * Deliberately withheld (null) until at least MIN_FRACTION_FOR_ETA of the
 * deployment is done — an estimate drawn from the first couple of percent
 * is noise, and a wrong countdown is worse than none. Also withheld once
 * effectively finished, where "0s remaining" adds nothing.
 */
const MIN_FRACTION_FOR_ETA = 0.08;

export function estimateEtaSeconds(percent: number, elapsedSeconds: number): number | null {
  const fraction = percent / 100;

  if (fraction < MIN_FRACTION_FOR_ETA || fraction >= 1 || elapsedSeconds <= 0) {
    return null;
  }

  const total = elapsedSeconds / fraction;
  return Math.max(1, Math.round(total - elapsedSeconds));
}

type Listener = (progress: DeployProgress) => void;

interface DeployJob {
  progress: DeployProgress;
  startedAtMs: number;
  expiryTimer: NodeJS.Timeout | null;
}

/**
 * How long a finished deployment is kept visible. A failure needs to stay
 * on screen long enough to actually be read, and a success is worth a
 * moment of "done" rather than vanishing mid-animation.
 */
const SUCCESS_RETENTION_MS = 15_000;
const FAILURE_RETENTION_MS = 10 * 60_000;

const jobs = new Map<number, DeployJob>();
const listeners = new Set<Listener>();

/** Test seam. */
export function resetDeployProgress(): void {
  for (const job of jobs.values()) {
    if (job.expiryTimer) {
      clearTimeout(job.expiryTimer);
    }
  }
  jobs.clear();
  listeners.clear();
}

/** Every deployment currently worth showing, newest first. */
export function listDeployProgress(): DeployProgress[] {
  return [...jobs.values()]
    .map((job) => job.progress)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function subscribeToDeployProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(progress: DeployProgress): void {
  for (const listener of listeners) {
    listener(progress);
  }
}

function scheduleExpiry(appId: number, job: DeployJob, ms: number): void {
  if (job.expiryTimer) {
    clearTimeout(job.expiryTimer);
  }
  job.expiryTimer = setTimeout(() => jobs.delete(appId), ms);
  // Never hold the process open just to expire a progress record.
  job.expiryTimer.unref?.();
}

export interface DeployProgressReporter {
  setStage(stage: DeployStage, detail?: string): void;
  /** Feeds a raw line of Docker build output, for the step counter. */
  observeBuildOutput(line: string): void;
  succeed(): void;
  fail(error: string, failedStage: DeployStage, rolledBack: boolean): void;
}

/** A reporter that does nothing — for callers that don't track progress. */
export const NULL_DEPLOY_REPORTER: DeployProgressReporter = {
  setStage() {},
  observeBuildOutput() {},
  succeed() {},
  fail() {}
};

export function startDeployProgress(
  appId: number,
  appName: string,
  source: string | null
): DeployProgressReporter {
  const startedAtMs = Date.now();

  const progress: DeployProgress = {
    appId,
    appName,
    source,
    status: "running",
    stage: "resolving-repository",
    stageLabel: DEPLOY_STAGE_LABELS["resolving-repository"],
    percent: 0,
    step: null,
    totalSteps: null,
    detail: "Starting…",
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: null,
    etaSeconds: null,
    error: null,
    failedStage: null,
    rolledBack: false
  };

  const job: DeployJob = { progress, startedAtMs, expiryTimer: null };
  jobs.set(appId, job);
  publish(progress);

  const refresh = () => {
    const next = deployPercent(progress.stage, progress.step, progress.totalSteps);

    // Never let the bar move backwards — a later stage with a smaller
    // computed value (or a re-reported step) must not rewind it.
    if (next > progress.percent) {
      progress.percent = next;
    }

    progress.etaSeconds = estimateEtaSeconds(
      progress.percent,
      (Date.now() - job.startedAtMs) / 1000
    );

    publish(progress);
  };

  return {
    setStage(stage, detail) {
      progress.stage = stage;
      progress.stageLabel = DEPLOY_STAGE_LABELS[stage];
      progress.detail = detail ?? DEPLOY_STAGE_LABELS[stage];

      // Leaving the build stage clears the step counter so a stale
      // "12/14" can't linger next to a later stage's label.
      if (stage !== "building-image") {
        progress.step = null;
        progress.totalSteps = null;
      }

      refresh();
    },

    observeBuildOutput(line) {
      const parsed = parseBuildStep(line);

      if (!parsed) {
        return;
      }

      progress.step = parsed.step;
      progress.totalSteps = parsed.total;
      refresh();
    },

    succeed() {
      progress.status = "succeeded";
      progress.stage = "deployment-complete";
      progress.stageLabel = DEPLOY_STAGE_LABELS["deployment-complete"];
      progress.percent = 100;
      progress.detail = "Deployed";
      progress.etaSeconds = null;
      progress.finishedAt = new Date().toISOString();
      publish(progress);
      scheduleExpiry(appId, job, SUCCESS_RETENTION_MS);
    },

    fail(error, failedStage, rolledBack) {
      progress.status = "failed";
      progress.error = error;
      progress.failedStage = failedStage;
      progress.stageLabel = DEPLOY_STAGE_LABELS[failedStage];
      progress.rolledBack = rolledBack;
      progress.etaSeconds = null;
      progress.finishedAt = new Date().toISOString();
      // Deliberately NOT set to 100 — a failed deployment never claims to
      // have completed.
      publish(progress);
      scheduleExpiry(appId, job, FAILURE_RETENTION_MS);
    }
  };
}

/** Removes a finished deployment early, e.g. when an operator dismisses it. */
export function dismissDeployProgress(appId: number): boolean {
  const job = jobs.get(appId);

  if (!job || job.progress.status === "running") {
    return false;
  }

  if (job.expiryTimer) {
    clearTimeout(job.expiryTimer);
  }

  jobs.delete(appId);
  return true;
}
