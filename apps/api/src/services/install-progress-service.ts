/**
 * Live progress for an app/template install.
 *
 * The percentage here is real, not a timer: the dominant cost of any
 * install is pulling the image, and Docker's own pull stream reports
 * per-layer byte counts (dockerode's followProgress third argument, which
 * the platform previously discarded). Those bytes drive the pull portion of
 * the bar; the remaining steps — volumes, container creation, start, and
 * routing — are discrete stages with fixed weights, because they have no
 * meaningful sub-progress to report and pretending otherwise would be a
 * fake animation.
 *
 * State is in-memory and short-lived, exactly like the model-pull tracking
 * in ollama-service.ts: an install lasts one request, and after an API
 * restart the honest answer is "no install is running". Nothing here is
 * authoritative about what exists — the app list is.
 */

/** Stages an app moves through, in order. */
export type InstallStage =
  | "queued"
  | "pulling"
  | "storage"
  | "creating"
  | "starting"
  | "routing"
  | "done";

/**
 * Where each stage ENDS on a single app's 0–100 scale. Pulling dominates
 * because it dominates real elapsed time — a multi-gigabyte image on a
 * small VPS is minutes, while creating and starting a container is
 * typically under a second.
 */
export const STAGE_CEILINGS: Record<InstallStage, number> = {
  queued: 0,
  pulling: 70,
  storage: 78,
  creating: 88,
  starting: 96,
  routing: 100,
  done: 100
};

export const STAGE_LABELS: Record<InstallStage, string> = {
  queued: "Waiting to start…",
  pulling: "Downloading image",
  storage: "Preparing storage",
  creating: "Creating container",
  starting: "Starting container",
  routing: "Configuring routing",
  done: "Ready"
};

export interface InstallServiceProgress {
  /** The app name being created. */
  name: string;
  stage: InstallStage;
  /** 0–100 for this service alone. */
  percent: number;
  /** Human-readable detail, e.g. "Downloading image (120 MB of 1.4 GB)". */
  detail: string;
}

export type InstallStatus = "running" | "succeeded" | "failed";

export interface InstallProgress {
  installId: string;
  status: InstallStatus;
  /** 0–100 across every service in this install. */
  percent: number;
  /** The service currently being worked on, for the headline line. */
  currentService: string | null;
  services: InstallServiceProgress[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** One dockerode pull-progress event (only the fields that matter here). */
export interface PullProgressEvent {
  id?: string;
  status?: string;
  progressDetail?: { current?: number; total?: number };
}

/**
 * Accumulates per-layer byte counts into an overall pull fraction.
 *
 * Docker reports each layer separately and repeats a layer's id as it
 * advances, so entries are REPLACED per id rather than summed over events.
 * Layers whose total is unknown (0) contribute nothing to the denominator
 * instead of being guessed at, which keeps the bar from lurching backwards
 * when a new layer's size is first announced.
 */
export class PullProgressAccumulator {
  private readonly layers = new Map<string, { current: number; total: number }>();

  /** Returns the fraction complete (0–1), or null while nothing is measurable. */
  update(event: PullProgressEvent): number | null {
    const id = event.id;
    const total = event.progressDetail?.total ?? 0;
    const current = event.progressDetail?.current ?? 0;

    if (id && total > 0) {
      this.layers.set(id, { current, total });
    }

    return this.fraction();
  }

  fraction(): number | null {
    let current = 0;
    let total = 0;

    for (const layer of this.layers.values()) {
      current += layer.current;
      total += layer.total;
    }

    if (total <= 0) {
      return null;
    }

    return Math.min(1, current / total);
  }

  /** Bytes downloaded and expected, for the detail line. */
  bytes(): { current: number; total: number } {
    let current = 0;
    let total = 0;

    for (const layer of this.layers.values()) {
      current += layer.current;
      total += layer.total;
    }

    return { current, total };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * A single service's percentage, given its stage and (for a pull) how far
 * through the download it is. Pure, so the weighting is directly testable.
 */
export function servicePercent(stage: InstallStage, pullFraction: number | null): number {
  if (stage === "pulling") {
    // Ramp across the pull band. With no measurable byte counts yet, sit at
    // the bottom of the band rather than inventing movement.
    return Math.round(STAGE_CEILINGS.pulling * (pullFraction ?? 0));
  }

  return STAGE_CEILINGS[stage];
}

/**
 * Overall percentage across every service. Services are weighted equally:
 * their real durations depend on image sizes the platform doesn't know
 * before pulling, and an equal split is a defensible, monotonic
 * approximation rather than a fabricated one.
 */
export function overallPercent(services: InstallServiceProgress[]): number {
  if (services.length === 0) {
    return 0;
  }

  const total = services.reduce((sum, service) => sum + service.percent, 0);
  return Math.round(total / services.length);
}

type Listener = (progress: InstallProgress) => void;

interface InstallJob {
  progress: InstallProgress;
  listeners: Set<Listener>;
  /** Cleared when a new subscriber arrives; set when the last one leaves. */
  expiryTimer: NodeJS.Timeout | null;
}

/**
 * How long a finished install's progress is kept so a client that connects
 * late (or reconnects) still sees the final result rather than a blank.
 */
const RETENTION_MS = 60_000;

const jobs = new Map<string, InstallJob>();

/** Test seam. */
export function resetInstallProgress(): void {
  for (const job of jobs.values()) {
    if (job.expiryTimer) {
      clearTimeout(job.expiryTimer);
    }
  }
  jobs.clear();
}

export function getInstallProgress(installId: string): InstallProgress | null {
  return jobs.get(installId)?.progress ?? null;
}

/**
 * Reports progress for one install. Created before the work starts so a
 * client that subscribes immediately never races the first update.
 */
export interface InstallReporter {
  /** Declares the services this install will create, in order. */
  begin(serviceNames: string[]): void;
  /** Moves a service to a new stage. */
  setStage(name: string, stage: InstallStage, detail?: string): void;
  /** Reports pull byte progress for a service. */
  setPullProgress(name: string, event: PullProgressEvent): void;
  succeed(): void;
  fail(error: string): void;
}

/** A reporter that does nothing — for callers that don't track progress. */
export const NULL_REPORTER: InstallReporter = {
  begin() {},
  setStage() {},
  setPullProgress() {},
  succeed() {},
  fail() {}
};

export function createInstallJob(installId: string): InstallReporter {
  const progress: InstallProgress = {
    installId,
    status: "running",
    percent: 0,
    currentService: null,
    services: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };

  const job: InstallJob = { progress, listeners: new Set(), expiryTimer: null };
  jobs.set(installId, job);

  const accumulators = new Map<string, PullProgressAccumulator>();

  const publish = () => {
    progress.percent = overallPercent(progress.services);
    for (const listener of job.listeners) {
      listener(progress);
    }
  };

  const service = (name: string): InstallServiceProgress | undefined =>
    progress.services.find((entry) => entry.name === name);

  const scheduleExpiry = () => {
    if (job.expiryTimer) {
      clearTimeout(job.expiryTimer);
    }
    job.expiryTimer = setTimeout(() => jobs.delete(installId), RETENTION_MS);
    // Never hold the process open just to expire a progress record.
    job.expiryTimer.unref?.();
  };

  return {
    begin(serviceNames) {
      progress.services = serviceNames.map((name) => ({
        name,
        stage: "queued" as const,
        percent: 0,
        detail: STAGE_LABELS.queued
      }));
      publish();
    },

    setStage(name, stage, detail) {
      const entry = service(name);
      if (!entry) {
        return;
      }

      entry.stage = stage;
      entry.percent = servicePercent(stage, accumulators.get(name)?.fraction() ?? null);
      entry.detail = detail ?? STAGE_LABELS[stage];
      progress.currentService = stage === "done" ? progress.currentService : name;
      publish();
    },

    setPullProgress(name, event) {
      const entry = service(name);
      if (!entry || entry.stage !== "pulling") {
        return;
      }

      let accumulator = accumulators.get(name);
      if (!accumulator) {
        accumulator = new PullProgressAccumulator();
        accumulators.set(name, accumulator);
      }

      const fraction = accumulator.update(event);
      const next = servicePercent("pulling", fraction);

      // Never let the bar move backwards — a new layer appearing in the
      // denominator can otherwise reduce the computed fraction.
      if (next > entry.percent) {
        entry.percent = next;
      }

      const { current, total } = accumulator.bytes();
      entry.detail =
        total > 0
          ? `${STAGE_LABELS.pulling} (${formatBytes(current)} of ${formatBytes(total)})`
          : STAGE_LABELS.pulling;

      publish();
    },

    succeed() {
      progress.status = "succeeded";
      progress.finishedAt = new Date().toISOString();
      for (const entry of progress.services) {
        entry.stage = "done";
        entry.percent = 100;
        entry.detail = STAGE_LABELS.done;
      }
      progress.currentService = null;
      publish();
      scheduleExpiry();
    },

    fail(error) {
      progress.status = "failed";
      progress.error = error;
      progress.finishedAt = new Date().toISOString();
      publish();
      scheduleExpiry();
    }
  };
}

/**
 * Subscribes to an install's progress. The current state is delivered
 * immediately so a subscriber never has to wait for the next change to
 * render something.
 */
export function subscribeToInstall(
  installId: string,
  listener: Listener
): (() => void) | null {
  const job = jobs.get(installId);

  if (!job) {
    return null;
  }

  if (job.expiryTimer) {
    clearTimeout(job.expiryTimer);
    job.expiryTimer = null;
  }

  job.listeners.add(listener);
  listener(job.progress);

  return () => {
    job.listeners.delete(listener);

    // Once a finished install has no subscribers left, let it expire.
    if (job.listeners.size === 0 && job.progress.status !== "running") {
      job.expiryTimer = setTimeout(() => jobs.delete(installId), RETENTION_MS);
      job.expiryTimer.unref?.();
    }
  };
}
