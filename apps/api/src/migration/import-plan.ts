import { isOurs, type DestinationDescriptor, type ResourceMarker } from "./destination.js";
import type { Manifest, ManifestArtifact } from "./manifest.js";

/**
 * The idempotent-import PLAN and JOURNAL model (docs/MIGRATION_BUNDLE_FORMAT.md §9).
 *
 * Phase 0 delivers the planner and the journal reducer as pure functions; the
 * executor that acts on them arrives in Phase 2. They are specified and tested
 * now so the guarantees are fixed before any code can write to a server:
 *
 *  - every step has a deterministic id, so a retry hits the SAME step;
 *  - a pre-existing resource is only ever treated as "ours" if its labels prove it
 *    was created by this very migration — names are never trusted;
 *  - anything else that is in the way is a CONFLICT and is never overwritten;
 *  - a crashed or repeated run resumes rather than duplicating.
 */

export type PlanAction = "create" | "already-applied" | "resume" | "conflict";
export type StepKind = "database" | "config" | "routes" | "volume" | "image" | "container";
export type Resolution = "rename" | "abort" | "replace-with-backup";

export interface PlanStep {
  /** Deterministic: "<kind>:<artifactId or resource name>". */
  id: string;
  kind: StepKind;
  artifactId: string | null;
  /** The destination resource this step creates or fills. */
  resource: string;
  appRef: string | null;
  action: PlanAction;
  reason: string;
  bytes: number;
  /** Offered resolutions when action is "conflict". "replace-with-backup" needs typed confirmation. */
  resolutions: Resolution[];
}

export interface ImportPlan {
  migrationId: string;
  bundleId: string;
  steps: PlanStep[];
  counts: Record<PlanAction, number>;
  /** False while any conflict is unresolved. */
  executable: boolean;
}

// ------------------------------------------------------------------ journal ----

export type StepState = "pending" | "in-progress" | "done" | "failed";

export interface JournalStep {
  state: StepState;
  attempts: number;
  lastError?: string;
  /** Digest of what was verified on the destination once the step finished. */
  verifiedSha256?: string;
}

export interface ImportJournal {
  journalVersion: 1;
  migrationId: string;
  bundleId: string;
  steps: Record<string, JournalStep>;
}

export const MAX_STEP_ATTEMPTS = 3;

export function newJournal(plan: Pick<ImportPlan, "migrationId" | "bundleId">): ImportJournal {
  return { journalVersion: 1, migrationId: plan.migrationId, bundleId: plan.bundleId, steps: {} };
}

function withStep(journal: ImportJournal, id: string, update: (current: JournalStep) => JournalStep): ImportJournal {
  const current = journal.steps[id] ?? { state: "pending", attempts: 0 };

  return { ...journal, steps: { ...journal.steps, [id]: update(current) } };
}

export const startStep = (journal: ImportJournal, id: string): ImportJournal =>
  withStep(journal, id, (step) => ({ state: "in-progress", attempts: step.attempts + 1 }));

export const completeStep = (journal: ImportJournal, id: string, verifiedSha256?: string): ImportJournal =>
  withStep(journal, id, (step) => ({ state: "done", attempts: step.attempts, verifiedSha256 }));

export const failStep = (journal: ImportJournal, id: string, error: string): ImportJournal =>
  withStep(journal, id, (step) => ({ state: "failed", attempts: step.attempts, lastError: error.slice(0, 500) }));

export interface NextActions {
  /** Steps to run now, in order. */
  runnable: PlanStep[];
  /** Steps that need no work. */
  skipped: string[];
  /** Why nothing can run, if blocked. */
  blocked: string | null;
}

/**
 * What a (re)started import should do. A step left "in-progress" by a crash is
 * treated as incomplete and re-run — it is ours and was never live, so redoing
 * it is safe. Conflicts and steps that exhausted their attempts block the run.
 */
export function nextActions(plan: ImportPlan, journal: ImportJournal | null): NextActions {
  const conflict = plan.steps.find((step) => step.action === "conflict");
  if (conflict) {
    return {
      runnable: [],
      skipped: [],
      blocked: `${conflict.resource} already exists and was not created by this migration. Resolve it (rename or abort); it will not be overwritten.`
    };
  }

  const runnable: PlanStep[] = [];
  const skipped: string[] = [];

  for (const step of plan.steps) {
    const entry = journal?.steps[step.id];

    if (step.action === "already-applied" || entry?.state === "done") {
      skipped.push(step.id);
      continue;
    }
    if (entry?.state === "failed" && entry.attempts >= MAX_STEP_ATTEMPTS) {
      return {
        runnable: [],
        skipped,
        blocked: `${step.id} failed ${entry.attempts} times (${entry.lastError ?? "unknown error"}). Investigate before retrying.`
      };
    }
    runnable.push(step);
  }

  return { runnable, skipped, blocked: null };
}

// ------------------------------------------------------------------ planner ----

const STEP_ORDER: Record<StepKind, number> = {
  database: 0,
  config: 1,
  routes: 2,
  volume: 3,
  image: 4,
  container: 5
};

const KIND_OF_ARTIFACT: Partial<Record<ManifestArtifact["kind"], StepKind>> = {
  "platform-database": "database",
  "platform-config": "config",
  "caddy-routes": "routes",
  volume: "volume",
  image: "image"
};

function decide(options: {
  marker: ResourceMarker | undefined;
  migrationId: string;
  sha: string | undefined;
  journalDone: boolean;
  /** For images: identical content already present counts as applied. */
  contentId?: string | null;
}): { action: PlanAction; reason: string } {
  const { marker, migrationId, sha, journalDone, contentId } = options;

  if (!marker) {
    return { action: "create", reason: "Does not exist on the destination." };
  }
  if (isOurs(marker, migrationId, sha)) {
    return journalDone
      ? { action: "already-applied", reason: "Created by this migration and recorded as complete." }
      : {
          action: "resume",
          reason: "Created by this migration but not recorded as complete; it was never live, so it is safe to redo."
        };
  }
  if (contentId && marker.contentId && marker.contentId === contentId) {
    return { action: "already-applied", reason: "An identical image is already present." };
  }

  return {
    action: "conflict",
    reason: marker.migrationId
      ? "Created by a different migration."
      : "Already exists and was not created by this migration. It will not be overwritten."
  };
}

/**
 * Computes what an import would do on `destination`, step by step. Pure and
 * read-only: nothing is created. Run it before importing and again on every
 * resume; it reaches the same answer for the same inputs.
 */
export function planImport(
  manifest: Manifest,
  destination: DestinationDescriptor,
  journal: ImportJournal | null = null
): ImportPlan {
  const migrationId = manifest.transfer.migrationId;
  const { inventory } = destination;
  const volumes = new Map(inventory.volumes.map((marker) => [marker.name, marker]));
  const images = new Map(inventory.images.map((marker) => [marker.name, marker]));
  const containers = new Map(inventory.containers.map((marker) => [marker.name, marker]));
  const done = (id: string): boolean => journal?.steps[id]?.state === "done";
  const steps: PlanStep[] = [];

  const volumeOwner = new Map<string, { appRef: string; name: string }>();
  const imageOwner = new Map<string, { appRef: string; tag: string }>();
  for (const app of manifest.apps) {
    for (const volume of app.volumes) {
      if (volume.artifactId) {
        volumeOwner.set(volume.artifactId, { appRef: app.ref, name: volume.name });
      }
    }
    for (const image of app.images) {
      if (image.artifactId) {
        imageOwner.set(image.artifactId, { appRef: app.ref, tag: image.tag });
      }
    }
  }

  for (const artifact of manifest.artifacts) {
    const kind = KIND_OF_ARTIFACT[artifact.kind];
    if (!kind) {
      continue;
    }

    const id = `${kind}:${artifact.id}`;
    const base = { id, kind, artifactId: artifact.id, bytes: artifact.plaintextBytes };

    if (kind === "volume") {
      const owner = volumeOwner.get(artifact.id);
      const resource = owner?.name ?? String(artifact.meta.volume ?? artifact.id);
      const verdict = decide({
        marker: volumes.get(resource),
        migrationId,
        sha: artifact.plaintextSha256,
        journalDone: done(id)
      });
      steps.push({ ...base, resource, appRef: owner?.appRef ?? null, ...verdict, resolutions: resolutionsFor(verdict.action) });
    } else if (kind === "image") {
      const owner = imageOwner.get(artifact.id);
      const resource = owner?.tag ?? String(artifact.meta.tag ?? artifact.id);
      const verdict = decide({
        marker: images.get(resource),
        migrationId,
        sha: artifact.plaintextSha256,
        journalDone: done(id),
        contentId: typeof artifact.meta.imageId === "string" ? artifact.meta.imageId : null
      });
      steps.push({ ...base, resource, appRef: owner?.appRef ?? null, ...verdict, resolutions: resolutionsFor(verdict.action) });
    } else {
      // Platform database/config/routes belong to a clean installation: replacing one that
      // already holds apps is never implicit.
      const populated = inventory.appNames.length > 0 && manifest.scope === "platform";
      const verdict: { action: PlanAction; reason: string } = populated
        ? {
            action: "conflict",
            reason: "The destination already manages apps; a full-server import will not replace a populated installation."
          }
        : done(id)
          ? { action: "already-applied", reason: "Recorded as complete." }
          : { action: "create", reason: "Destination installation is clean." };
      steps.push({
        ...base,
        resource: kind === "database" ? "platform database" : kind === "config" ? "platform configuration" : "proxy routes",
        appRef: null,
        ...verdict,
        resolutions: populated ? ["abort"] : []
      });
    }
  }

  for (const app of manifest.apps) {
    const id = `container:${app.ref}`;
    const verdict = decide({
      marker: containers.get(app.containerName),
      migrationId,
      sha: undefined,
      journalDone: done(id)
    });
    steps.push({
      id,
      kind: "container",
      artifactId: null,
      resource: app.containerName,
      appRef: app.ref,
      bytes: 0,
      ...verdict,
      resolutions: resolutionsFor(verdict.action)
    });
  }

  steps.sort((a, b) => STEP_ORDER[a.kind] - STEP_ORDER[b.kind] || a.id.localeCompare(b.id));

  const counts: Record<PlanAction, number> = { create: 0, "already-applied": 0, resume: 0, conflict: 0 };
  for (const step of steps) {
    counts[step.action] += 1;
  }

  return {
    migrationId,
    bundleId: manifest.bundleId,
    steps,
    counts,
    executable: counts.conflict === 0
  };
}

function resolutionsFor(action: PlanAction): Resolution[] {
  return action === "conflict" ? ["rename", "abort", "replace-with-backup"] : [];
}
