import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable, pipeline } from "node:stream";
import tarFs from "tar-fs";
import { readAppDefinition, type UnexportedItem } from "./app-definition.js";
import { BundleWriter, verifyBundle, type BundleVerification, type ManifestBody } from "./bundle.js";
import {
  classifyConsistency,
  evaluateConsistencyPolicy,
  meetsLevel,
  weakestLevel,
  type ConsistencyEvidence,
  type ConsistencyLevel,
  type SnapshotStrategy
} from "./consistency.js";
import { findAppDependencies } from "./dependencies.js";
import type { ExportDockerClient } from "./export-docker.js";
import type { AppPlan, ExportPlan, Refusal, VolumePlan } from "./export-plan.js";
import { JournalStore, recoverDisruptions, type RestoreOptions } from "./export-journal.js";
import { appRef, type PlatformFacts } from "./facts.js";
import type { EncryptionKeyStatus } from "../services/crypto-service.js";
import { verifyDump, verifyPostgresCleanShutdown, HookVerificationError } from "./hooks.js";
import { openReadOnly } from "./inventory.js";
import type { Manifest, ManifestApp } from "./manifest.js";
import { ContainerMissingError, DisruptionGuard, type RestoreSummary, type StopOutcome } from "./quiesce.js";
import { buildReport, formatBytes, type CheckResult, type VerificationReport } from "./report.js";
import { fingerprintOf } from "./signing.js";
import { ByteCounter, TailCapture, compressed, counted } from "./streams.js";
import { normalizePassphrase, type KdfCost } from "./crypto.js";
import { bundleVerificationChecks } from "./preflight.js";

/**
 * The export ORCHESTRATOR.
 *
 * It turns an approved plan into an encrypted bundle, and it is structured around
 * one promise: whatever goes wrong — a failed stream, a full disk, a hook that
 * proves nothing, Ctrl-C, a timeout — every app that was stopped or paused is
 * started again, helper containers are removed, the half-written bundle is
 * deleted, and the caller is told plainly whether restoration succeeded.
 *
 * Phase 1 only READS installation state. It never imports, restores, replaces or
 * hands over anything; there is no code path here that writes to a volume, a
 * container, the database or the configuration.
 */

export class ExportRefusedError extends Error {
  constructor(readonly refusals: Refusal[]) {
    super(`The export was refused: ${refusals.map((refusal) => refusal.message).join(" ")}`);
    this.name = "ExportRefusedError";
  }
}

export class ExportBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportBusyError";
  }
}

export class ConsistencyGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsistencyGateError";
  }
}

export class ExportVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportVerificationError";
  }
}

/** The export failed. `restore` says whether every disturbed app was put back. */
export class ExportFailedError extends Error {
  constructor(
    readonly causeError: Error,
    readonly restore: RestoreSummary,
    readonly bundleRemoved: boolean,
    readonly bundlePath: string
  ) {
    super(causeError.message);
    this.name = "ExportFailedError";
  }

  /** True if some app could NOT be restored — the one outcome that needs a human right now. */
  get restoreFailed(): boolean {
    return this.restore.failed.length > 0;
  }
}

export interface ExportRunOptions {
  verify: "none" | "structure" | "deep";
  gzipLevel: number;
  graceSeconds: number;
  /** An app is never held stopped/paused longer than this; the export aborts and restores instead. */
  maxDisruptionMs: number;
  kdf?: KdfCost;
  chunkSize?: number;
  bundleName?: string;
  log: (message: string) => void;
  now: () => Date;
  signal?: AbortSignal;
  restore: RestoreOptions;
  /** Free bytes at a path, or null if unknown. */
  freeSpace: (path: string) => number | null;
  /** Abort rather than let the output disk drop below this many free bytes. */
  minFreeBytes: number;
  watchIntervalMs: number;
  heartbeatIntervalMs: number;
  /**
   * Called before each major step (e.g. "database", "volume", "finalize"). Does nothing in
   * production; tests use it to inject a failure or a cancellation at every step.
   */
  onStep?: (step: string) => void | Promise<void>;
}

export function defaultRunOptions(overrides: Partial<ExportRunOptions> = {}): ExportRunOptions {
  return {
    verify: "deep",
    gzipLevel: 3,
    graceSeconds: 30,
    maxDisruptionMs: 30 * 60_000,
    log: () => undefined,
    now: () => new Date(),
    restore: {},
    freeSpace: () => null,
    minFreeBytes: 128 * 1024 * 1024,
    watchIntervalMs: 2000,
    heartbeatIntervalMs: 10_000,
    ...overrides
  };
}

export interface ExportRunInput {
  plan: ExportPlan;
  facts: PlatformFacts;
  dbPath: string;
  outputDir: string;
  passphrase: string;
  /** PKCS#8 PEM. Omit for an unsigned bundle. */
  signingKeyPem?: string;
  client: ExportDockerClient;
  encryption: EncryptionKeyStatus;
  hostPaths: { configDir: string | null; routesDir: string | null };
  /** Where the recovery journal and the temporary database snapshot live. */
  stateDir: string;
  /** A local image used for volume-reading helper containers (never pulled). */
  helperImage: string;
  server: { serverId: string; platformVersion: string; schemaVersion: number; arch: string; dockerVersion: string };
  options: ExportRunOptions;
}

export interface ExportedVolume {
  name: string;
  containerPath: string;
  strategy: SnapshotStrategy;
  level: ConsistencyLevel;
  evidence: ConsistencyEvidence[];
  artifactKind: "volume" | "db-dump";
  uncompressedBytes: number;
}

export interface ExportResult {
  bundlePath: string;
  bundleId: string;
  manifestSha256: string;
  signerFingerprint: string | null;
  scope: ExportPlan["scope"];
  operation: ExportPlan["operation"];
  mode: ExportPlan["mode"];
  artifacts: Array<{ id: string; kind: string; subject: string; plaintextBytes: number; ciphertextBytes: number }>;
  apps: Array<{ ref: string; name: string; strategy: SnapshotStrategy; volumes: ExportedVolume[]; images: number }>;
  overallConsistency: ConsistencyLevel;
  acceptedRisks: Manifest["consistency"]["acceptedRisks"];
  disruptions: Array<{ app: string; action: "stop" | "pause"; seconds: number }>;
  unexported: Array<{ app: string } & UnexportedItem>;
  warnings: string[];
  verification: BundleVerification | null;
  startedAt: string;
  finishedAt: string;
}

const PLAIN_ABORT = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "The export was cancelled.");

// ------------------------------------------------------------------ entry ----

export async function runExport(input: ExportRunInput): Promise<ExportResult> {
  const { plan, options } = input;

  if (plan.refusals.length > 0) {
    throw new ExportRefusedError(plan.refusals);
  }

  // An export that cannot possibly succeed must never disturb anything: check the passphrase first.
  normalizePassphrase(input.passphrase);

  // The bundle name becomes a directory name, and a failed export DELETES that directory:
  // it must never be able to point anywhere but directly inside the output directory.
  if (options.bundleName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.bundleName)) {
    throw new Error("The bundle name may contain only letters, digits, '.', '_' and '-', must not start with '.' or '-', and may be at most 100 characters.");
  }

  // An earlier export that was killed may have left apps disturbed. Put them right FIRST.
  const recovered = await recoverDisruptions(input.client, input.stateDir, { ...options.restore, now: options.now });
  if (recovered.some((entry) => entry.skippedActive)) {
    throw new ExportBusyError("Another export is running (its recovery journal has a recent heartbeat). Wait for it to finish.");
  }
  const stuck = recovered.filter((entry) => entry.failed.length > 0);
  if (stuck.length > 0) {
    throw new ExportBusyError(
      `An earlier interrupted export left apps that could not be restored (${stuck.flatMap((entry) => entry.failed.map((f) => f.containerName)).join(", ")}). ` +
        "Restore them (`deployment-platform migrate recover`) before exporting again."
    );
  }
  for (const entry of recovered.filter((r) => r.restored.length > 0)) {
    options.log(`Recovered from an earlier interrupted export: restarted ${entry.restored.join(", ")}.`);
  }

  const stamp = options.now().toISOString().replace(/[:.]/g, "-");
  const bundlePath = resolve(input.outputDir, options.bundleName ?? `cfmig-${plan.scope}-${stamp}`);
  if (existsSync(bundlePath)) {
    throw new Error(`Refusing to write over an existing path: ${bundlePath}`);
  }

  return new ExportRun(input, bundlePath).execute();
}

// -------------------------------------------------------------------- run ----

class ExportRun {
  private readonly plan: ExportPlan;
  private readonly options: ExportRunOptions;
  private readonly abort = new AbortController();
  private readonly journal: JournalStore;
  private readonly guard: DisruptionGuard;
  private readonly openArchives = new Set<{ dispose(): Promise<void> }>();
  private readonly volumes = new Map<string, ExportedVolume[]>();
  private readonly images = new Map<string, ManifestApp["images"]>();
  private readonly warnings: string[] = [];
  private readonly acceptedRisks = new Map<string, ConsistencyLevel>();
  private writer: BundleWriter | null = null;
  private bundleCreated = false;
  private readonly startedAt: Date;

  constructor(
    private readonly input: ExportRunInput,
    private readonly bundlePath: string
  ) {
    this.plan = input.plan;
    this.options = input.options;
    this.startedAt = input.options.now();
    this.journal = new JournalStore(input.stateDir, randomUUID(), input.options.now);
    this.guard = new DisruptionGuard(input.client, this.journal, {
      ...input.options.restore,
      graceSeconds: input.options.graceSeconds
    });
  }

  async execute(): Promise<ExportResult> {
    const { options } = this;
    const onExternalAbort = (): void => this.abort.abort(PLAIN_ABORT(options.signal?.reason));
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted) {
      onExternalAbort();
    }

    await this.journal.create(this.bundlePath);
    const heartbeat = setInterval(() => void this.journal.heartbeat().catch(() => undefined), options.heartbeatIntervalMs);
    const watch = setInterval(() => this.watchDisk(), options.watchIntervalMs);
    heartbeat.unref();
    watch.unref();

    try {
      // The path did not exist (checked in runExport), so anything found there afterwards is ours to clean up.
      this.bundleCreated = true;
      this.writer = await BundleWriter.create(this.bundlePath, {
        passphrase: this.input.passphrase,
        kdf: options.kdf,
        chunkSize: options.chunkSize,
        signingKeyPem: this.input.signingKeyPem
      });
      options.log(`Writing encrypted bundle to ${this.bundlePath}`);

      await this.exportWithoutDisruption();
      for (const window of this.plan.windows) {
        await this.exportWindow(window.apps);
      }

      await this.step("finalize");
      const finalized = await this.finalize();
      await this.step("verify");
      const verification = await this.verify();

      // By now every window has restored its apps; make that a checked fact, not an assumption.
      const leftovers = await this.guard.restoreAll();
      if (leftovers.failed.length > 0) {
        throw new Error(`Apps could not be restored: ${leftovers.failed.map((f) => f.containerName).join(", ")}`);
      }
      await this.disposeOpenArchives();

      // Build the result BEFORE the journal is deleted: the disruption record comes from it.
      const result = this.result(finalized, verification);
      await this.journal.remove();

      return result;
    } catch (error) {
      const cause = this.abort.signal.aborted ? PLAIN_ABORT(this.abort.signal.reason) : (error as Error);
      this.abort.abort(cause);
      options.log(`Export failed: ${cause.message}. Restoring applications…`);

      const restore = await this.guard.restoreAll();
      await this.disposeOpenArchives();
      const bundleRemoved = await this.removeBundle();
      if (restore.failed.length === 0) {
        await this.journal.remove().catch(() => undefined);
      }

      throw new ExportFailedError(cause, restore, bundleRemoved, this.bundlePath);
    } finally {
      clearInterval(heartbeat);
      clearInterval(watch);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  // ------------------------------------------------------------ safety ----

  private throwIfAborted(): void {
    if (this.abort.signal.aborted) {
      throw PLAIN_ABORT(this.abort.signal.reason);
    }
  }

  private async step(name: string): Promise<void> {
    this.throwIfAborted();
    await this.options.onStep?.(name);
  }

  /** Aborts BEFORE the output disk is full, so the export can never starve the host. */
  private watchDisk(): void {
    const free = this.options.freeSpace(this.input.outputDir);
    if (free !== null && free < this.options.minFreeBytes && !this.abort.signal.aborted) {
      this.abort.abort(
        new Error(`The output disk is nearly full (${formatBytes(free)} free); stopping before it fills.`)
      );
    }
  }

  /**
   * Removes helper containers, retrying. They are harmless (never started, labelled) but must
   * not accumulate. A persistent failure is a WARNING, not an export failure: the label lets
   * `migrate recover` sweep them later.
   */
  private async disposeOpenArchives(): Promise<void> {
    for (const archive of [...this.openArchives]) {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await archive.dispose();
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) {
        this.warnings.push(
          `A helper container could not be removed (${(lastError as Error).message}). It is harmless and labelled; "migrate recover" removes it.`
        );
      }
      this.openArchives.delete(archive);
    }
  }

  /** Deletes the bundle directory this run created — and only that. */
  private async removeBundle(): Promise<boolean> {
    if (!this.bundleCreated) {
      return false;
    }
    const root = resolve(this.input.outputDir) + sep;
    if (!this.bundlePath.startsWith(root)) {
      return false;
    }
    await rm(this.bundlePath, { recursive: true, force: true });

    return true;
  }

  // ---------------------------------------------------------- artifacts ----

  private get bundle(): BundleWriter {
    if (!this.writer) {
      throw new Error("The bundle has not been created.");
    }

    return this.writer;
  }

  private signal(extra?: AbortSignal): AbortSignal {
    return extra ? AbortSignal.any([this.abort.signal, extra]) : this.abort.signal;
  }

  private async addJson(kind: "app-definition", subject: `app:${number}`, meta: Record<string, string | number | boolean>, value: unknown) {
    this.throwIfAborted();
    const id = this.bundle.allocateArtifactId();

    return this.bundle.addArtifact({ id, kind, subject, meta }, Buffer.from(JSON.stringify(value)));
  }

  private async addStream(
    spec: { kind: "volume" | "db-dump" | "platform-database" | "platform-config" | "caddy-routes" | "image"; subject: "platform" | `app:${number}`; meta: Record<string, string | number | boolean> },
    source: Readable
  ) {
    this.throwIfAborted();
    const id = this.bundle.allocateArtifactId();

    return this.bundle.addArtifact({ id, ...spec }, source);
  }

  // ------------------------------------------------- non-disruptive work ----

  private async exportWithoutDisruption(): Promise<void> {
    const { plan } = this;

    if (plan.scope === "application") {
      for (const app of plan.apps) {
        await this.step("definition");
        const definition = readAppDefinition({
          dbPath: this.input.dbPath,
          facts: this.input.facts,
          appId: app.id,
          operation: plan.operation === "backup" ? "copy" : plan.operation,
          selection: plan.apps.map((entry) => entry.id),
          encryption: this.input.encryption,
          unexported: app.unexported
        });
        await this.addJson("app-definition", app.ref as `app:${number}`, { definitionVersion: 1 }, definition);
        this.options.log(`Captured the definition of "${app.name}".`);
      }
    }

    if (plan.platform.database) {
      await this.exportDatabase();
    }
    if (plan.platform.config && this.input.hostPaths.configDir) {
      await this.exportDirectory("platform-config", this.input.hostPaths.configDir, "configuration and secrets");
    }
    if (plan.platform.routes && this.input.hostPaths.routesDir) {
      await this.exportDirectory("caddy-routes", this.input.hostPaths.routesDir, "proxy routes");
    }

    for (const app of plan.apps) {
      for (const image of app.images) {
        await this.exportImage(app, image);
      }
    }

    // Verified dumps and live copies disturb nothing, so they go before any quiesce window.
    for (const app of plan.apps) {
      if (app.strategy === "hook") {
        for (const volume of app.volumes) {
          await this.exportDump(app, volume);
        }
        this.gate(app);
      } else if (app.strategy === "live") {
        for (const volume of app.volumes) {
          await this.exportVolume(app, volume, []);
        }
        this.gate(app);
      } else if (app.strategy !== "stop" && app.strategy !== "freeze" && app.volumes.length > 0) {
        for (const volume of app.volumes) {
          await this.exportVolume(app, volume, []);
        }
        this.gate(app);
      }
    }
  }

  private async exportDatabase(): Promise<void> {
    await this.step("database");
    const workDir = await mkdtemp(join(this.input.stateDir, "snap-"));
    const snapshot = join(workDir, "platform.sqlite");

    try {
      this.options.log("Snapshotting the platform database (transactionally consistent)…");
      // VACUUM INTO is refused under query_only; this handle is still strictly read-only.
      const source = openReadOnly(this.input.dbPath, { queryOnly: false });
      try {
        source.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      } finally {
        source.close();
      }

      // Evidence, not assumption: the snapshot must pass SQLite's own integrity check.
      const check = new DatabaseSync(snapshot, { readOnly: true });
      let schemaVersion = 0;
      try {
        const rows = check.prepare("PRAGMA integrity_check").all() as unknown as Array<Record<string, unknown>>;
        const verdict = rows.map((row) => String(Object.values(row)[0])).join("; ");
        if (verdict !== "ok") {
          throw new Error(`The database snapshot failed its integrity check: ${verdict}`);
        }
        schemaVersion = Number((check.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | bigint | null }).v ?? 0);
      } finally {
        check.close();
      }

      const counter = new ByteCounter();
      const entry = await this.addStream(
        {
          kind: "platform-database",
          subject: "platform",
          meta: {
            format: "sqlite",
            source: "VACUUM INTO",
            compression: "gzip",
            integrity: "ok",
            schemaVersion,
            consistency: "application-consistent",
            evidence: "app-snapshot-verified: VACUUM INTO snapshot passed PRAGMA integrity_check"
          }
        },
        compressed(createReadStream(snapshot), { level: this.options.gzipLevel, signal: this.abort.signal, counter })
      );
      entry.meta.uncompressedBytes = counter.bytes;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async exportDirectory(kind: "platform-config" | "caddy-routes", directory: string, label: string): Promise<void> {
    await this.step(kind === "platform-config" ? "config" : "routes");
    this.options.log(`Archiving ${label}…`);
    const counter = new ByteCounter();
    const entry = await this.addStream(
      { kind, subject: "platform", meta: { format: "tar", compression: "gzip" } },
      compressed(tarFs.pack(directory), { level: this.options.gzipLevel, signal: this.abort.signal, counter })
    );
    entry.meta.uncompressedBytes = counter.bytes;
  }

  private async exportImage(app: AppPlan, image: AppPlan["images"][number]): Promise<void> {
    await this.step("image");
    this.options.log(`Saving image ${image.tag}…`);
    const id = await this.input.client.imageId(image.tag);
    const stream = await this.input.client.imageSave(image.tag);
    const counter = new ByteCounter();
    const entry = await this.addStream(
      {
        kind: "image",
        subject: app.ref as `app:${number}`,
        meta: { tag: image.tag, role: image.role, format: "docker-save", compression: "none", ...(id ? { imageId: id } : {}) }
      },
      counted(stream, { signal: this.abort.signal, counter })
    );
    entry.meta.uncompressedBytes = counter.bytes;
    this.images.set(app.ref, [
      ...(this.images.get(app.ref) ?? []),
      { tag: image.tag, artifactId: entry.id, sizeBytes: counter.bytes, role: image.role }
    ]);
  }

  // ------------------------------------------------------------ volumes ----

  /** Streams one volume as a gzip'd tar, with no intermediate copy. */
  private async exportVolume(
    app: AppPlan,
    volume: VolumePlan,
    evidence: ConsistencyEvidence[],
    extraSignal?: AbortSignal
  ): Promise<void> {
    await this.step("volume");
    this.options.log(`Streaming volume ${volume.volumeName} of "${app.name}" (${volume.strategy})…`);
    const signal = this.signal(extraSignal);
    const archive = await this.input.client.volumeArchive(volume.volumeName, { helperImage: this.input.helperImage, signal });
    this.openArchives.add(archive);

    try {
      const counter = new ByteCounter();
      const entry = await this.addStream(
        {
          kind: "volume",
          subject: app.ref as `app:${number}`,
          meta: { volume: volume.volumeName, mountPath: volume.containerPath, format: "tar", compression: "gzip" }
        },
        compressed(archive.stream, { level: this.options.gzipLevel, signal, counter })
      );
      entry.meta.uncompressedBytes = counter.bytes;

      this.record(app, {
        name: volume.volumeName,
        containerPath: volume.containerPath,
        strategy: volume.strategy,
        level: classifyConsistency({ strategy: volume.strategy, hasPersistentState: true, evidence }),
        evidence,
        artifactKind: "volume",
        uncompressedBytes: counter.bytes,
        artifactId: entry.id
      });
    } finally {
      // Housekeeping must never fail (and so disrupt) an export whose data was read correctly.
      // On failure the archive stays tracked and is retried at the end.
      try {
        await archive.dispose();
        this.openArchives.delete(archive);
      } catch {
        // retried by disposeOpenArchives()
      }
    }
  }

  /** Streams a verified logical dump from the running app. The dump is evidence only if it VERIFIES. */
  private async exportDump(app: AppPlan, volume: VolumePlan): Promise<void> {
    const hook = volume.hook;
    if (!hook) {
      throw new Error(`No hook was planned for "${app.name}".`);
    }
    await this.step("dump");
    this.options.log(`Taking a verified ${hook.id} dump of "${app.name}" (the app keeps running)…`);

    const stream = await this.input.client.exec(app.containerName, hook.cmd, { user: hook.user, signal: this.abort.signal });
    const tail = new TailCapture();
    const tapped = pipeline(stream.stdout, tail, (error) => {
      if (error) {
        tail.destroy(error);
      }
    });
    const counter = new ByteCounter();
    const entry = await this.addStream(
      {
        kind: "db-dump",
        subject: app.ref as `app:${number}`,
        meta: { volume: volume.volumeName, hook: hook.id, format: hook.format, compression: "gzip" }
      },
      compressed(tapped, { level: this.options.gzipLevel, signal: this.abort.signal, counter })
    );
    entry.meta.uncompressedBytes = counter.bytes;

    const finished = await stream.finished();
    const verdict = verifyDump(hook, { exitCode: finished.exitCode, bytes: tail.bytes, tail: tail.tailText(), stderr: finished.stderr });
    if (!verdict.ok) {
      throw new HookVerificationError(`The ${hook.id} dump of "${app.name}" could not be verified: ${verdict.detail}.`);
    }

    const evidence: ConsistencyEvidence[] = [{ kind: "logical-dump-verified", detail: verdict.detail }];
    this.record(app, {
      name: volume.volumeName,
      containerPath: volume.containerPath,
      strategy: "hook",
      level: classifyConsistency({ strategy: "hook", hasPersistentState: true, evidence }),
      evidence,
      artifactKind: "db-dump",
      uncompressedBytes: tail.bytes,
      artifactId: entry.id
    });
  }

  private record(app: AppPlan, volume: ExportedVolume & { artifactId: string }): void {
    this.volumes.set(app.ref, [...(this.volumes.get(app.ref) ?? []), volume]);
  }

  /** The runtime policy check: evidence actually obtained, judged against the same cutover rules. */
  private gate(app: AppPlan): void {
    const exported = this.volumes.get(app.ref) ?? [];
    if (exported.length === 0 || !app.profile.hasPersistentState) {
      return;
    }
    const level = weakestLevel(exported.map((volume) => volume.level));
    const accepted = app.acceptedRisk !== null && meetsLevel(level, app.acceptedRisk);
    const verdict = evaluateConsistencyPolicy({ profile: app.profile, level, mode: this.plan.mode, accepted });

    if (!verdict.allowed) {
      throw new ConsistencyGateError(`"${app.name}": ${verdict.message}`);
    }
    if (level !== "application-consistent" && accepted && app.acceptedRisk) {
      this.acceptedRisks.set(app.ref, app.acceptedRisk);
    }
    if (verdict.severity === "warn" && this.plan.mode === "rehearsal") {
      this.warnings.push(`"${app.name}" was captured as ${level}; do not use this bundle for cutover.`);
    }
  }

  // ------------------------------------------------------------ windows ----

  /**
   * Quiesces a set of apps (dependents first), snapshots them, and restores them
   * (dependencies first) — restoring in a `finally`, so a failure mid-snapshot
   * still brings everything back before the error propagates.
   */
  private async exportWindow(refs: string[]): Promise<void> {
    const members = refs.map((ref) => this.plan.apps.find((app) => app.ref === ref)!);
    const deadline = AbortSignal.timeout(this.options.maxDisruptionMs);
    const outcomes = new Map<string, StopOutcome | { frozen: true }>();
    let primary: unknown;

    try {
      for (const app of members) {
        await this.step("window-quiesce");
        if (app.strategy === "stop") {
          this.options.log(`Stopping "${app.name}"…`);
          try {
            outcomes.set(app.ref, await this.guard.stop(app));
          } catch (error) {
            if (!(error instanceof ContainerMissingError)) {
              throw error;
            }
            outcomes.set(app.ref, { wasRunning: false, exitCode: null, oomKilled: false, cleanExit: false, forcedKill: false });
          }
        } else {
          this.options.log(`Pausing "${app.name}"…`);
          await this.guard.freeze(app);
          outcomes.set(app.ref, { frozen: true });
        }
      }

      for (const app of members) {
        const outcome = outcomes.get(app.ref)!;
        for (const volume of app.volumes) {
          const evidence = await this.evidenceFor(app, volume, outcome);
          await this.exportVolume(app, volume, evidence, deadline);
        }
        this.gate(app);
      }
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      const failures: Array<{ containerName: string; error: string }> = [];
      for (const app of [...members].reverse()) {
        this.options.log(`Restoring "${app.name}"…`);
        try {
          await this.guard.restore(app.ref);
        } catch (error) {
          failures.push({ containerName: app.containerName, error: (error as Error).message });
        }
      }
      if (failures.length > 0 && primary === undefined) {
        throw new Error(`Apps could not be restored: ${failures.map((f) => `${f.containerName} (${f.error})`).join("; ")}`);
      }
    }
  }

  /** Process-level facts from the stop, plus application-level evidence where it can be obtained. */
  private async evidenceFor(app: AppPlan, volume: VolumePlan, outcome: StopOutcome | { frozen: true }): Promise<ConsistencyEvidence[]> {
    if ("frozen" in outcome) {
      return [{ kind: "frozen" }];
    }

    const evidence: ConsistencyEvidence[] = [];
    if (outcome.cleanExit) {
      evidence.push({ kind: "clean-exit", detail: `exit status ${outcome.exitCode}` });
    }
    if (outcome.forcedKill) {
      evidence.push({ kind: "forced-kill", detail: outcome.oomKilled ? "killed for exceeding its memory limit" : `exit status ${outcome.exitCode}` });
    }

    if (volume.shutdownCheck === "postgres") {
      try {
        const info = await this.input.client.inspectContainer(app.containerName);
        const check = await verifyPostgresCleanShutdown(this.input.client, {
          image: info?.image ?? app.containerName,
          volumeName: volume.volumeName,
          mountPath: volume.containerPath,
          pgdata: info?.env.PGDATA,
          signal: this.abort.signal
        });
        if (check.ok) {
          evidence.push({ kind: "clean-shutdown-marker-verified", detail: check.detail });
        } else {
          this.warnings.push(`"${app.name}": ${check.detail}; the data is not proven consistent.`);
        }
      } catch (error) {
        this.warnings.push(`"${app.name}": the PostgreSQL shutdown check could not run (${(error as Error).message}); the data is not proven consistent.`);
      }
    }

    return evidence;
  }

  // ---------------------------------------------------------- finishing ----

  private async finalize(): Promise<{ manifest: Manifest; manifestSha256: string }> {
    const { plan, input } = this;

    const apps: ManifestApp[] = plan.apps.map((app) => {
      const facts = input.facts.apps.find((entry) => entry.id === app.id)!;
      const exported = this.volumes.get(app.ref) ?? [];

      return {
        ref: app.ref,
        sourceAppId: app.id,
        name: app.name,
        containerName: app.containerName,
        image: facts.image,
        domain: facts.domain,
        internalOnly: facts.internalOnly,
        desiredStatus: facts.desiredStatus,
        volumes: app.volumes.map((planned) => {
          const done = (exported as Array<ExportedVolume & { artifactId: string }>).find((entry) => entry.name === planned.volumeName)!;

          return {
            name: planned.volumeName,
            containerPath: planned.containerPath,
            readOnly: facts.volumes.find((v) => v.volumeName === planned.volumeName)?.readOnly ?? false,
            artifactId: done.artifactId,
            sizeBytes: done.uncompressedBytes,
            consistency: { level: done.level, strategy: done.strategy, evidence: done.evidence }
          };
        }),
        images: this.images.get(app.ref) ?? [],
        dependsOn: findAppDependencies(input.facts, app.id).strong.map(appRef),
        dormantOnImport: plan.operation === "copy"
      };
    });

    const levels = apps.flatMap((app) => app.volumes.map((volume) => volume.consistency.level));
    const body: ManifestBody = {
      scope: plan.scope,
      source: {
        serverId: input.server.serverId,
        platformVersion: input.server.platformVersion,
        schemaVersion: input.server.schemaVersion,
        arch: input.server.arch,
        dockerVersion: input.server.dockerVersion
      },
      transfer: { migrationId: randomUUID(), operation: plan.operation, epoch: 0, previousBundleId: null },
      consistency: {
        mode: plan.mode,
        overall: weakestLevel(levels),
        acceptedRisks: [...this.acceptedRisks].map(([subject, level]) => ({
          subject: subject as `app:${number}`,
          level,
          acceptedAt: this.options.now().toISOString(),
          reason: "accepted explicitly by the operator (--accept-risk)"
        }))
      },
      apps,
      createdAt: this.options.now().toISOString()
    };

    return this.bundle.finalize(body);
  }

  private async verify(): Promise<BundleVerification | null> {
    if (this.options.verify === "none") {
      return null;
    }
    this.options.log(`Verifying the finished bundle (${this.options.verify})…`);
    const pin = this.input.signingKeyPem ? signerFingerprintOf(this.input.signingKeyPem) : undefined;
    const verification = await verifyBundle(this.bundlePath, this.input.passphrase, {
      deep: this.options.verify === "deep",
      expectedSignerFingerprint: pin
    });

    if (verification.integrity.status !== "verified" || verification.authenticity.status === "failed") {
      throw new ExportVerificationError(
        `The finished bundle failed verification: ${[...verification.integrity.problems.map((p) => p.message), ...verification.authenticity.notes].join(" ")}`
      );
    }

    return verification;
  }

  private result(finalized: { manifest: Manifest; manifestSha256: string }, verification: BundleVerification | null): ExportResult {
    const { manifest } = finalized;
    const entries = this.journal.entries().filter((entry) => entry.wasRunning);

    return {
      bundlePath: this.bundlePath,
      bundleId: manifest.bundleId,
      manifestSha256: finalized.manifestSha256,
      signerFingerprint: this.input.signingKeyPem ? signerFingerprintOf(this.input.signingKeyPem) : null,
      scope: manifest.scope,
      operation: this.plan.operation,
      mode: this.plan.mode,
      artifacts: manifest.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        subject: artifact.subject,
        plaintextBytes: artifact.plaintextBytes,
        ciphertextBytes: artifact.ciphertextBytes
      })),
      apps: this.plan.apps.map((app) => ({
        ref: app.ref,
        name: app.name,
        strategy: app.strategy,
        volumes: this.volumes.get(app.ref) ?? [],
        images: (this.images.get(app.ref) ?? []).length
      })),
      overallConsistency: manifest.consistency.overall,
      acceptedRisks: manifest.consistency.acceptedRisks,
      disruptions: entries.map((entry) => ({
        app: entry.containerName,
        action: entry.action,
        seconds: entry.restoredAt ? Math.max(0, (new Date(entry.restoredAt).getTime() - new Date(entry.at).getTime()) / 1000) : 0
      })),
      unexported: this.plan.apps.flatMap((app) => app.unexported.map((item) => ({ app: app.name, ...item }))),
      warnings: [...this.plan.warnings, ...this.warnings],
      verification,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.options.now().toISOString()
    };
  }
}

function signerFingerprintOf(pem: string): string {
  return fingerprintOf(createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }) as Buffer);
}

// ------------------------------------------------------------------ report ----

/** The export outcome as the shared verification report (text and JSON renderers come for free). */
export function buildExportReport(result: ExportResult, now: Date = new Date()): VerificationReport {
  const checks: CheckResult[] = [];
  const total = result.artifacts.reduce((sum, artifact) => sum + artifact.ciphertextBytes, 0);

  checks.push({
    id: "export.completed",
    title: "Encrypted bundle written",
    status: "pass",
    detail: `${result.bundlePath} — ${result.artifacts.length} artifact(s), ${formatBytes(total)} encrypted. Every artifact and the manifest are AES-256-GCM encrypted.`
  });

  for (const app of result.apps) {
    for (const volume of app.volumes) {
      const strong = volume.level === "application-consistent";
      checks.push({
        id: "export.consistency",
        title: `${app.name}: ${volume.name}`,
        subject: app.ref,
        status: strong ? "pass" : "warn",
        detail:
          `${volume.level} via ${volume.strategy}` +
          (volume.evidence.length > 0 ? ` — evidence: ${volume.evidence.map((e) => `${e.kind}${e.detail ? ` (${e.detail})` : ""}`).join("; ")}` : " — no evidence beyond the strategy itself") +
          (strong ? "" : ". Not proof of application consistency."),
        remediation: strong ? undefined : "For cutover, use a verified dump hook or a verified clean shutdown, or record an explicit risk acceptance."
      });
    }
  }

  checks.push(
    result.disruptions.length === 0
      ? { id: "export.disruption", title: "Application disruption", status: "pass", detail: "No application was stopped or paused." }
      : {
          id: "export.disruption",
          title: "Application disruption",
          status: "info",
          detail: result.disruptions.map((d) => `${d.app} was ${d.action === "stop" ? "stopped" : "paused"} for ${d.seconds.toFixed(1)}s and restored`).join("; ") + "."
        }
  );

  for (const item of result.unexported) {
    checks.push({
      id: "export.unexported",
      title: `${item.app}: not exported (${item.kind})`,
      subject: undefined,
      status: "warn",
      detail: `${item.destination}: ${item.detail}`,
      remediation: "This data is NOT in the bundle and will not exist on the destination."
    });
  }
  for (const warning of result.warnings) {
    checks.push({ id: "export.warning", title: "Note", status: "warn", detail: warning });
  }

  checks.push(
    result.signerFingerprint
      ? { id: "export.signature", title: "Bundle signature", status: "info", detail: `Signed. Signer fingerprint: ${result.signerFingerprint}. Give this to the destination operator out of band and verify with --expect-signer.` }
      : { id: "export.signature", title: "Bundle signature", status: "warn", detail: "The bundle is NOT signed, so its origin cannot be proven on import.", remediation: "Pass --signing-key-file to sign it." }
  );

  if (result.verification) {
    checks.push(...bundleVerificationChecks(result.verification));
  }

  return buildReport({
    kind: "export",
    role: "source",
    scope: result.scope,
    checks,
    integrity: result.verification?.integrity,
    authenticity: result.verification?.authenticity,
    sections: {
      export: {
        bundlePath: result.bundlePath,
        bundleId: result.bundleId,
        manifestSha256: result.manifestSha256,
        mode: result.mode,
        operation: result.operation,
        overallConsistency: result.overallConsistency,
        acceptedRisks: result.acceptedRisks,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt
      }
    },
    now
  });
}

/** The size of a path if it exists (for disk planning). */
export function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
