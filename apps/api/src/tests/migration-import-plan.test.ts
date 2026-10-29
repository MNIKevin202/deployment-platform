import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { LABEL_ARTIFACT_SHA256, LABEL_MIGRATION_ID } from "../migration/constants.js";
import {
  buildDescriptor,
  type DestinationDescriptor,
  type ResourceMarker
} from "../migration/destination.js";
import {
  completeStep,
  failStep,
  MAX_STEP_ATTEMPTS,
  newJournal,
  nextActions,
  planImport,
  startStep,
  type ImportJournal,
  type ImportPlan
} from "../migration/import-plan.js";
import type { Manifest } from "../migration/manifest.js";
import { buildSyntheticBundle, cleanupTempDirs, VOLUME_NAME, APP_NAME } from "./migration-fixtures.js";

after(cleanupTempDirs);

const MIGRATION_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_MIGRATION = "55555555-5555-4555-8555-555555555555";

async function manifestWithImage(scope: "platform" | "application" = "platform"): Promise<Manifest> {
  const bundle = await buildSyntheticBundle({
    scope,
    body: { transfer: { migrationId: MIGRATION_ID, operation: "backup", epoch: 0, previousBundleId: null } }
  });
  const manifest: Manifest = structuredClone(bundle.manifest);

  manifest.artifacts.push({
    id: "a0099",
    kind: "image",
    subject: "app:1",
    plaintextBytes: 1000,
    plaintextSha256: "e".repeat(64),
    ciphertextBytes: 1038,
    ciphertextSha256: "f".repeat(64),
    meta: { tag: "deployment-app-1:abc123def456", imageId: "sha256:wanted" }
  });
  manifest.apps[0]!.images.push({ tag: "deployment-app-1:abc123def456", artifactId: "a0099", sizeBytes: 1000, role: "current" });

  return manifest;
}

function emptyDescriptor(overrides: Partial<DestinationDescriptor["inventory"]> = {}): DestinationDescriptor {
  const descriptor = buildDescriptor({
    host: {
      serverId: "srv-0000000000000001",
      hostname: "dest",
      arch: "x64",
      osDescription: "Synthetic",
      dockerVersion: "27",
      memTotalBytes: 16 * 1024 ** 3,
      cpuCount: 4,
      freeDiskBytes: 500 * 1024 ** 3,
      totalDiskBytes: 1000 * 1024 ** 3,
      diskPath: null
    },
    platformVersion: "1.9.0",
    facts: null,
    maxSchemaVersion: 28,
    keyId: null,
    containers: [],
    volumes: [],
    images: []
  });
  descriptor.inventory = { ...descriptor.inventory, ...overrides };

  return descriptor;
}

const marker = (name: string, extra: Partial<ResourceMarker> = {}): ResourceMarker => ({
  name,
  migrationId: null,
  artifactSha256: null,
  contentId: null,
  ...extra
});

const stepFor = (plan: ImportPlan, resource: string) => plan.steps.find((step) => step.resource === resource);

describe("import planner", () => {
  test("a clean destination plans to create everything, in a safe order, with stable ids", async () => {
    const manifest = await manifestWithImage();
    const plan = planImport(manifest, emptyDescriptor());

    assert.equal(plan.executable, true);
    assert.deepEqual(plan.counts, { create: plan.steps.length, "already-applied": 0, resume: 0, conflict: 0 });
    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ["database", "config", "volume", "image", "container"]
    );
    assert.deepEqual(
      plan.steps.map((step) => step.id),
      ["database:a0001", "config:a0002", "volume:a0003", "image:a0099", "container:app:1"]
    );
    assert.equal(plan.migrationId, MIGRATION_ID);
  });

  test("planning is deterministic: the same inputs always give the same plan", async () => {
    const manifest = await manifestWithImage();
    const destination = emptyDescriptor({ volumes: [marker("something-unrelated")] });

    assert.equal(JSON.stringify(planImport(manifest, destination)), JSON.stringify(planImport(manifest, destination)));
  });

  test("an existing unlabelled volume is a conflict and is never planned for creation", async () => {
    const manifest = await manifestWithImage();
    const plan = planImport(manifest, emptyDescriptor({ volumes: [marker(VOLUME_NAME)] }));
    const step = stepFor(plan, VOLUME_NAME)!;

    assert.equal(step.action, "conflict");
    assert.match(step.reason, /not created by this migration/);
    assert.deepEqual(step.resolutions, ["rename", "abort", "replace-with-backup"]);
    assert.equal(plan.executable, false);
    assert.equal(plan.counts.conflict, 1);
    // No step is a "create" of the colliding resource.
    assert.ok(plan.steps.filter((s) => s.resource === VOLUME_NAME).every((s) => s.action !== "create"));
  });

  test("ownership is proven by labels, never by name", async () => {
    const manifest = await manifestWithImage();
    const volume = manifest.artifacts.find((artifact) => artifact.kind === "volume")!;
    const planFor = (m: ResourceMarker) => stepFor(planImport(manifest, emptyDescriptor({ volumes: [m] })), VOLUME_NAME)!;

    assert.equal(
      planFor(marker(VOLUME_NAME, { migrationId: MIGRATION_ID, artifactSha256: volume.plaintextSha256 })).action,
      "resume"
    );
    // Same migration, but the artifact digest differs: the volume is not what we would have written.
    assert.equal(
      planFor(marker(VOLUME_NAME, { migrationId: MIGRATION_ID, artifactSha256: "0".repeat(64) })).action,
      "conflict"
    );
    // A different migration, even with the right digest.
    const other = planFor(marker(VOLUME_NAME, { migrationId: OTHER_MIGRATION, artifactSha256: volume.plaintextSha256 }));
    assert.equal(other.action, "conflict");
    assert.match(other.reason, /different migration/);
  });

  test("a resource that is ours and recorded complete is already applied; one that is not is resumed", async () => {
    const manifest = await manifestWithImage();
    const volume = manifest.artifacts.find((artifact) => artifact.kind === "volume")!;
    const destination = emptyDescriptor({
      volumes: [marker(VOLUME_NAME, { migrationId: MIGRATION_ID, artifactSha256: volume.plaintextSha256 })]
    });

    const resumed = stepFor(planImport(manifest, destination), VOLUME_NAME)!;
    assert.equal(resumed.action, "resume");
    assert.match(resumed.reason, /never live, so it is safe to redo/);

    const journal = completeStep(startStep(newJournal(planImport(manifest, destination)), "volume:a0003"), "volume:a0003", volume.plaintextSha256);
    assert.equal(stepFor(planImport(manifest, destination, journal), VOLUME_NAME)!.action, "already-applied");
  });

  test("identical image content is recognised; different content under the same tag conflicts", async () => {
    const manifest = await manifestWithImage();
    const tag = "deployment-app-1:abc123def456";

    const identical = planImport(manifest, emptyDescriptor({ images: [marker(tag, { contentId: "sha256:wanted" })] }));
    assert.equal(stepFor(identical, tag)!.action, "already-applied");

    const different = planImport(manifest, emptyDescriptor({ images: [marker(tag, { contentId: "sha256:other" })] }));
    assert.equal(stepFor(different, tag)!.action, "conflict");
  });

  test("an existing container with the app's name is a conflict unless this migration made it", async () => {
    const manifest = await manifestWithImage();
    const name = `app-${APP_NAME}`;

    assert.equal(stepFor(planImport(manifest, emptyDescriptor({ containers: [marker(name)] })), name)!.action, "conflict");
    assert.equal(
      stepFor(planImport(manifest, emptyDescriptor({ containers: [marker(name, { migrationId: MIGRATION_ID })] })), name)!.action,
      "resume"
    );
  });

  test("a full-server import will not replace a populated installation", async () => {
    const manifest = await manifestWithImage();
    const plan = planImport(manifest, emptyDescriptor({ appNames: ["existing-app"] }));
    const database = plan.steps.find((step) => step.kind === "database")!;

    assert.equal(database.action, "conflict");
    assert.deepEqual(database.resolutions, ["abort"]); // there is deliberately no 'replace' option here
    assert.equal(plan.executable, false);
  });

  test("application scope plans only the app's own resources", async () => {
    const bundle = await buildSyntheticBundle({ scope: "application" });
    const manifest: Manifest = structuredClone(bundle.manifest);
    manifest.artifacts = manifest.artifacts.filter((artifact) => artifact.kind === "volume");
    const plan = planImport(manifest, emptyDescriptor({ appNames: ["something-else"] }));

    assert.deepEqual(plan.steps.map((step) => step.kind), ["volume", "container"]);
    assert.equal(plan.executable, true);
  });
});

describe("import journal and resume", () => {
  async function fresh(): Promise<{ plan: ImportPlan; journal: ImportJournal }> {
    const plan = planImport(await manifestWithImage(), emptyDescriptor());

    return { plan, journal: newJournal(plan) };
  }

  test("a fresh import runs every step; a conflict blocks everything", async () => {
    const { plan, journal } = await fresh();
    const next = nextActions(plan, journal);

    assert.equal(next.blocked, null);
    assert.equal(next.runnable.length, plan.steps.length);

    const manifest = await manifestWithImage();
    const conflicted = planImport(manifest, emptyDescriptor({ volumes: [marker(VOLUME_NAME)] }));
    const blocked = nextActions(conflicted, null);

    assert.deepEqual(blocked.runnable, []);
    assert.match(blocked.blocked!, new RegExp(`${VOLUME_NAME}.*will not be overwritten`));
  });

  test("reducers record attempts, verified digests and bounded errors", async () => {
    const { journal } = await fresh();
    const started = startStep(startStep(journal, "volume:a0003"), "volume:a0003");
    assert.equal(started.steps["volume:a0003"]?.attempts, 2);
    assert.equal(started.steps["volume:a0003"]?.state, "in-progress");

    const done = completeStep(started, "volume:a0003", "abc");
    assert.equal(done.steps["volume:a0003"]?.state, "done");
    assert.equal(done.steps["volume:a0003"]?.verifiedSha256, "abc");

    const failed = failStep(startStep(journal, "x"), "x", "e".repeat(2000));
    assert.equal(failed.steps.x?.lastError?.length, 500);
    assert.ok(!("x" in journal.steps)); // the original journal is never mutated
  });

  test("steps that are done are skipped, and a step left in-progress by a crash is re-run", async () => {
    const { plan, journal } = await fresh();
    let j = completeStep(startStep(journal, "database:a0001"), "database:a0001");
    j = startStep(j, "config:a0002"); // crashed here: in-progress, never finished
    const next = nextActions(plan, j);

    assert.deepEqual(next.skipped, ["database:a0001"]);
    assert.equal(next.runnable[0]?.id, "config:a0002");
    assert.equal(next.runnable.length, plan.steps.length - 1);
  });

  test("repeated failures stop the import instead of looping forever", async () => {
    const { plan, journal } = await fresh();
    let j = journal;
    for (let attempt = 0; attempt < MAX_STEP_ATTEMPTS; attempt += 1) {
      j = failStep(startStep(j, "config:a0002"), "config:a0002", "disk full");
    }

    const next = nextActions(plan, j);
    assert.deepEqual(next.runnable, []);
    assert.match(next.blocked!, /failed 3 times \(disk full\)/);

    // One fewer attempt is still retryable.
    const retryable = failStep(startStep(startStep(journal, "config:a0002"), "config:a0002"), "config:a0002", "disk full");
    assert.equal(nextActions(plan, retryable).blocked, null);
  });

  test("a crash at ANY point resumes to completion without redoing finished work", async () => {
    const { plan } = await fresh();
    const total = plan.steps.length;

    for (let crashAfter = 0; crashAfter <= total; crashAfter += 1) {
      for (const crashMidStep of [false, true]) {
        const executed: string[] = [];
        let journal = newJournal(plan);

        // First run, which "crashes" after `crashAfter` completed steps.
        for (const step of nextActions(plan, journal).runnable.slice(0, crashAfter)) {
          journal = startStep(journal, step.id);
          executed.push(step.id);
          journal = completeStep(journal, step.id);
        }
        if (crashMidStep && crashAfter < total) {
          const interrupted = nextActions(plan, journal).runnable[0]!;
          journal = startStep(journal, interrupted.id); // started, never finished
          executed.push(interrupted.id);
        }

        const finishedBeforeCrash = Object.entries(journal.steps)
          .filter(([, step]) => step.state === "done")
          .map(([id]) => id);

        // The resume.
        const resumeExecuted: string[] = [];
        for (const step of nextActions(plan, journal).runnable) {
          journal = startStep(journal, step.id);
          resumeExecuted.push(step.id);
          journal = completeStep(journal, step.id);
        }

        assert.ok(
          resumeExecuted.every((id) => !finishedBeforeCrash.includes(id)),
          `resume redid finished work (crashAfter=${crashAfter}, mid=${crashMidStep})`
        );
        assert.equal(Object.values(journal.steps).filter((s) => s.state === "done").length, total);
        assert.ok(Object.values(journal.steps).every((s) => s.attempts <= 2)); // at most one retry

        // Idempotent: a further run finds nothing to do.
        const again = nextActions(plan, journal);
        assert.deepEqual(again.runnable, []);
        assert.equal(again.skipped.length, total);
      }
    }
  });
});
