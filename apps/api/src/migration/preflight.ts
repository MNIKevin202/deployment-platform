import { verifyBundle, type BundleVerification, type VerifyOptions } from "./bundle.js";
import {
  analyzeDependencies,
  type DependencyAnalysis,
  type Operation
} from "./dependencies.js";
import {
  buildDescriptor,
  credentialKeyId,
  evaluateDestination,
  isLocalBuildTag,
  requiredDiskBytes,
  requirementsFromFacts,
  requirementsFromManifest,
  type DestinationDescriptor
} from "./destination.js";
import {
  ceilingWithoutEvidence,
  classifyDataProfile,
  evaluateConsistencyPolicy,
  type DataProfile
} from "./consistency.js";
import { appRef, type AppFacts, type PlatformFacts } from "./facts.js";
import { planImport } from "./import-plan.js";
import {
  type ContainerDetail,
  type DiskUsage,
  type DockerHostInfo,
  type HostFacts,
  type ReadOnlyDockerProbe,
  collectHostFacts
} from "./probes.js";
import { buildReport, formatBytes, type CheckResult, type VerificationReport } from "./report.js";
import { decryptSecret, type EncryptionKeyStatus } from "../services/crypto-service.js";

/**
 * Read-only preflight. These functions receive DATA and a read-only Docker
 * probe; they cannot start, stop, create, remove or modify anything, and never
 * emit environment values, credentials or key material.
 */

// ------------------------------------------------------------------ helpers ----

const check = (result: CheckResult): CheckResult => result;

const IN_FLIGHT_UPDATE = new Set(["checking", "downloading", "installing", "migrating", "health_checking", "rolling_back"]);
const STUCK_UPDATE = new Set(["failed", "manual_intervention_required"]);

export interface SourcePreflightInput {
  scope: "platform" | "application";
  operation: Operation | "backup";
  appId?: number;
  /** Apps migrating together with the target (application scope). */
  selection?: number[];
  facts: PlatformFacts | null;
  factsError?: string | null;
  docker: ReadOnlyDockerProbe;
  encryption: EncryptionKeyStatus;
  platformVersion: string;
  /** Highest schema migration this build knows. */
  maxKnownSchemaVersion: number;
  /** Free bytes where the bundle would be written, if known. */
  outputFreeBytes?: number | null;
  outputFreeSource?: string;
  /** A destination described by that server, to evaluate against. */
  destination?: DestinationDescriptor | null;
  diskPath?: string | null;
  now?: Date;
}

export interface AppAssessment {
  ref: string;
  name: string;
  container: { exists: boolean; running: boolean; desired: string };
  profile: { kind: DataProfile["kind"]; isDatabase: boolean; reasons: string[]; recommendation: string };
  volumes: Array<{ name: string; containerPath: string; exists: boolean; sizeBytes: number | null }>;
  images: Array<{ tag: string; role: "current" | "rollback" | "registry"; local: boolean; sizeBytes: number | null }>;
  consistency: {
    defaultStrategy: "stop";
    /** The best a plain stop can establish without application-level evidence. */
    levelWithoutEvidence: string;
    cutoverWithoutEvidence: "allowed" | "needs-evidence-or-acceptance" | "not-applicable";
  };
}

// ------------------------------------------------------------ source preflight ----

export async function runSourcePreflight(input: SourcePreflightInput): Promise<VerificationReport> {
  const checks: CheckResult[] = [];
  const sections: Record<string, unknown> = {};
  const finish = (application?: { id: number; name: string }): VerificationReport =>
    buildReport({ kind: "preflight", role: "source", scope: input.scope, checks, application, sections, now: input.now });

  // --- the platform database ------------------------------------------------
  const { facts } = input;
  if (!facts) {
    checks.push(
      check({
        id: "source.database.readable",
        title: "Platform database can be read",
        status: "fail",
        detail: input.factsError ?? "The platform database could not be read.",
        remediation: "Check the database path and that this tool runs against a ClovaForge installation."
      })
    );
    return finish();
  }

  checks.push(
    check({
      id: "source.database.readable",
      title: "Platform database can be read",
      status: "pass",
      detail: `Read ${facts.apps.length} app(s) at schema v${facts.schemaVersion} (opened read-only; no migration was run).`
    }),
    check(
      facts.integrityCheck === "ok"
        ? {
            id: "source.database.integrity",
            title: "Platform database passes its integrity check",
            status: "pass",
            detail: "SQLite quick_check reported ok."
          }
        : {
            id: "source.database.integrity",
            title: "Platform database passes its integrity check",
            status: "fail",
            detail: `SQLite quick_check reported: ${facts.integrityCheck}`,
            remediation: "Restore from a known-good backup before migrating a damaged database."
          }
    ),
    check(
      facts.schemaVersion > input.maxKnownSchemaVersion
        ? {
            id: "source.schema.version",
            title: "Database schema is understood by this tool",
            status: "fail",
            detail: `The database is at schema v${facts.schemaVersion} but this build only knows v${input.maxKnownSchemaVersion}.`,
            remediation: "Run the migration tool from the same ClovaForge release as the database."
          }
        : {
            id: "source.schema.version",
            title: "Database schema is understood by this tool",
            status: "pass",
            detail: `Schema v${facts.schemaVersion} (this build knows up to v${input.maxKnownSchemaVersion}).`
          }
    )
  );

  // --- which apps are in scope ------------------------------------------------
  let subjects: AppFacts[] = facts.apps;
  let application: { id: number; name: string } | undefined;

  if (input.scope === "application") {
    const target = facts.apps.find((app) => app.id === input.appId);
    if (!target) {
      checks.push(
        check({
          id: "source.app.exists",
          title: "The application exists",
          status: "fail",
          detail: `No application with id ${input.appId ?? "(none given)"} was found.`,
          remediation: "Pass a valid application id or name."
        })
      );
      return finish();
    }
    const together = new Set([target.id, ...(input.selection ?? [])]);
    subjects = facts.apps.filter((app) => together.has(app.id));
    application = { id: target.id, name: target.name };
  }

  // --- docker -----------------------------------------------------------------
  let info: DockerHostInfo;
  try {
    info = await input.docker.info();
    checks.push(
      check({
        id: "source.docker.reachable",
        title: "Docker daemon is reachable",
        status: "pass",
        detail: `Docker ${info.dockerVersion} (${info.arch}).`
      })
    );
  } catch (error) {
    checks.push(
      check({
        id: "source.docker.reachable",
        title: "Docker daemon is reachable",
        status: "fail",
        detail: `The Docker daemon could not be queried: ${(error as Error).message}`,
        remediation: "Make sure Docker is running and this tool can reach its socket."
      })
    );
    return finish(application);
  }

  const host: HostFacts = collectHostFacts(info, input.diskPath ?? null);
  sections.server = {
    serverId: host.serverId,
    hostname: host.hostname,
    arch: host.arch,
    dockerVersion: host.dockerVersion,
    memTotalBytes: host.memTotalBytes,
    cpuCount: host.cpuCount,
    platformVersion: input.platformVersion,
    schemaVersion: facts.schemaVersion
  };
  const [volumes, images] = await Promise.all([input.docker.listVolumes(), input.docker.listImages()]);
  let usage: DiskUsage = { volumeSizes: new Map(), imageSizes: new Map() };
  try {
    usage = await input.docker.diskUsage();
  } catch {
    checks.push(
      check({
        id: "source.docker.usage",
        title: "Volume and image sizes are available",
        status: "warn",
        detail: "Docker could not report disk usage, so transfer size and free-space checks are approximate.",
        remediation: "Retry; `docker system df` shows whether the daemon can compute usage."
      })
    );
  }

  const volumeNames = new Set(volumes.map((volume) => volume.name));
  const localTags = new Set(images.flatMap((image) => image.tags));

  // --- credentials & keys -------------------------------------------------------
  const hasCredentials = facts.credentialPayloads.length > 0;
  if (!input.encryption.available) {
    checks.push(
      check({
        id: "source.crypto.key",
        title: "Credential encryption key is available",
        status: hasCredentials ? "fail" : "warn",
        detail: `CREDENTIAL_ENCRYPTION_KEY is unavailable (${input.encryption.reason}).`,
        remediation: hasCredentials
          ? "Stored credentials cannot be read without the key; supply the same key this installation runs with."
          : "No credentials are stored, but provide the key so the check can run fully."
      })
    );
  } else {
    checks.push(
      check({
        id: "source.crypto.key",
        title: "Credential encryption key is available",
        status: "pass",
        detail: "A valid 32-byte key is configured (its value is never read out)."
      })
    );

    let readable = 0;
    const unreadable: string[] = [];
    for (const credential of facts.credentialPayloads) {
      try {
        decryptSecret(input.encryption.key, credential.encryptedPayload);
        readable += 1;
      } catch {
        unreadable.push(credential.provider);
      }
    }
    checks.push(
      check(
        unreadable.length === 0
          ? {
              id: "source.crypto.credentials",
              title: "Stored credentials decrypt with the current key",
              status: facts.credentialPayloads.length === 0 ? "info" : "pass",
              detail:
                facts.credentialPayloads.length === 0
                  ? "No provider credentials are stored."
                  : `${readable} stored credential(s) decrypt correctly (checked in memory; nothing was printed).`
            }
          : {
              id: "source.crypto.credentials",
              title: "Stored credentials decrypt with the current key",
              status: "fail",
              detail: `${unreadable.length} credential(s) cannot be decrypted with the current key: ${unreadable.join(", ")}.`,
              remediation:
                "Migrating them would carry unusable credentials. Re-enter them on the source, or find the key they were encrypted with."
            }
      )
    );
  }

  // --- per-app assessment --------------------------------------------------------
  const assessments: AppAssessment[] = [];
  const containerDetails = new Map<number, ContainerDetail | null>();
  for (const app of subjects) {
    containerDetails.set(app.id, await input.docker.inspectContainer(app.containerName));
  }

  for (const app of subjects) {
    const ref = appRef(app.id);
    const detail = containerDetails.get(app.id) ?? null;
    const profile = classifyDataProfile({
      image: app.image,
      mountPaths: app.volumes.map((volume) => volume.containerPath),
      envKeys: app.env.map((entry) => entry.key),
      hasVolumes: app.volumes.length > 0
    });

    // Runtime state
    if (!detail) {
      checks.push(
        check({
          id: "source.app.runtime",
          title: `${app.name}: container state`,
          subject: ref,
          status: "warn",
          detail: `The container "${app.containerName}" does not exist. Only the app's definition and its volumes can be exported.`,
          remediation: "Redeploy the app first if you want its running state captured."
        })
      );
    } else if (app.desiredStatus === "running" && !detail.running) {
      checks.push(
        check({
          id: "source.app.runtime",
          title: `${app.name}: container state`,
          subject: ref,
          status: "warn",
          detail: `The app should be running but the container is "${detail.status}"${detail.oomKilled ? " (it was killed for running out of memory)" : ""}.`,
          remediation: "Start the app and confirm it is healthy, so the export reflects a working application."
        })
      );
    } else {
      checks.push(
        check({
          id: "source.app.runtime",
          title: `${app.name}: container state`,
          subject: ref,
          status: "pass",
          detail: `Container is ${detail.status}.`
        })
      );
    }

    // Volumes & mounts
    const volumeRows = app.volumes.map((volume) => ({
      name: volume.volumeName,
      containerPath: volume.containerPath,
      exists: volumeNames.has(volume.volumeName),
      sizeBytes: usage.volumeSizes.get(volume.volumeName) ?? null
    }));
    const missingVolumes = volumeRows.filter((volume) => !volume.exists);
    if (app.volumes.length > 0) {
      checks.push(
        check(
          missingVolumes.length === 0
            ? {
                id: "source.app.volumes",
                title: `${app.name}: persistent volumes`,
                subject: ref,
                status: "pass",
                detail: `${volumeRows.length} volume(s) present (${formatBytes(volumeRows.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0))}${volumeRows.some((v) => v.sizeBytes === null) ? ", some sizes unknown" : ""}).`
              }
            : {
                id: "source.app.volumes",
                title: `${app.name}: persistent volumes`,
                subject: ref,
                status: "warn",
                detail: `${missingVolumes.length} recorded volume(s) do not exist in Docker: ${missingVolumes.map((v) => v.name).join(", ")}. There is no data to export for them.`,
                remediation: "If this data should exist, stop and investigate before migrating."
              }
        )
      );
    }

    if (detail) {
      const recorded = new Set(app.volumes.map((volume) => volume.volumeName));
      const binds = detail.mounts.filter((mount) => mount.type === "bind");
      const unrecorded = detail.mounts.filter(
        (mount) => mount.type === "volume" && mount.name !== null && !recorded.has(mount.name)
      );
      const odd: string[] = [];
      if (binds.length > 0) {
        odd.push(`bind mounts at ${binds.map((mount) => mount.destination).join(", ")} (host paths are not exported)`);
      }
      if (unrecorded.length > 0) {
        odd.push(`volumes not recorded in ClovaForge at ${unrecorded.map((mount) => mount.destination).join(", ")} (would not be exported)`);
      }
      if (detail.privileged) {
        odd.push("runs privileged");
      }
      if (detail.networkMode === "host") {
        odd.push("uses host networking");
      }
      if (odd.length > 0) {
        checks.push(
          check({
            id: "source.app.mounts",
            title: `${app.name}: unsupported configuration`,
            subject: ref,
            status: "warn",
            detail: `This container ${odd.join("; ")}.`,
            remediation: "Move the data into a named ClovaForge volume, or accept that it will not be migrated."
          })
        );
      }
    }

    // Images
    const imageRows: AppAssessment["images"] = [];
    const seen = new Set<string>();
    for (const deployment of app.deployments) {
      if (seen.has(deployment.imageTag)) {
        continue;
      }
      seen.add(deployment.imageTag);
      if (isLocalBuildTag(deployment.imageTag)) {
        imageRows.push({
          tag: deployment.imageTag,
          role: deployment.isCurrent ? "current" : "rollback",
          local: localTags.has(deployment.imageTag),
          sizeBytes: usage.imageSizes.get(deployment.imageTag) ?? null
        });
      }
    }
    if (!app.source && !seen.has(app.image)) {
      imageRows.push({ tag: app.image, role: "registry", local: localTags.has(app.image), sizeBytes: usage.imageSizes.get(app.image) ?? null });
    }
    const missingBuilds = imageRows.filter((image) => image.role !== "registry" && !image.local);
    const localBuilds = imageRows.filter((image) => image.role !== "registry" && image.local);
    if (imageRows.some((image) => image.role !== "registry")) {
      checks.push(
        check(
          missingBuilds.length === 0
            ? {
                id: "source.app.images",
                title: `${app.name}: images needed for recovery and rollback`,
                subject: ref,
                status: "pass",
                detail: `${localBuilds.length} locally built image(s) exist and can be carried (${formatBytes(localBuilds.reduce((sum, image) => sum + (image.sizeBytes ?? 0), 0))}).`
              }
            : {
                id: "source.app.images",
                title: `${app.name}: images needed for recovery and rollback`,
                subject: ref,
                status: "warn",
                detail: `${missingBuilds.length} retained build image(s) no longer exist locally (${missingBuilds.map((image) => image.tag).join(", ")}). Rolling back to those versions will not work on the destination.`,
                remediation: "They cannot be recovered from the database; the destination can rebuild from source only for the current commit."
              }
        )
      );
    }

    // Consistency expectations — a plain stop is never counted as application-consistent.
    const level = ceilingWithoutEvidence("stop");
    const policy = evaluateConsistencyPolicy({ profile, level, mode: "cutover", accepted: false });
    checks.push(
      check(
        !profile.hasPersistentState
          ? {
              id: "source.app.consistency",
              title: `${app.name}: data consistency`,
              subject: ref,
              status: "pass",
              detail: "No persistent state, so there is nothing to make consistent."
            }
          : {
              id: "source.app.consistency",
              title: `${app.name}: data consistency`,
              subject: ref,
              status: "warn",
              detail:
                `Looks like ${profile.isDatabase ? `a ${profile.kind} database` : "an app with persistent data of unknown type"} ` +
                `(${profile.reasons.join("; ")}). Stopping it would establish only "${level}" — not application consistency. ` +
                (policy.requiresAcceptance ? "A cutover-grade export needs application-level evidence or an explicit risk acceptance." : ""),
              remediation: profile.recommendation,
              data: { profile: profile.kind, levelWithoutEvidence: level }
            }
      )
    );

    assessments.push({
      ref,
      name: app.name,
      container: { exists: detail !== null, running: detail?.running ?? false, desired: app.desiredStatus },
      profile: { kind: profile.kind, isDatabase: profile.isDatabase, reasons: profile.reasons, recommendation: profile.recommendation },
      volumes: volumeRows,
      images: imageRows,
      consistency: {
        defaultStrategy: "stop",
        levelWithoutEvidence: level,
        cutoverWithoutEvidence: !profile.hasPersistentState ? "not-applicable" : policy.allowed ? "allowed" : "needs-evidence-or-acceptance"
      }
    });
  }
  sections.apps = assessments;

  // --- activity that could change data mid-export ----------------------------------
  const subjectIds = new Set(subjects.map((app) => app.id));
  const locked = facts.activeDeploymentLockAppIds.filter((id) => input.scope === "platform" || subjectIds.has(id));
  checks.push(
    check(
      locked.length === 0
        ? { id: "source.activity.deployments", title: "No deployment in progress", status: "pass", detail: "No deployment lock is held." }
        : {
            id: "source.activity.deployments",
            title: "No deployment in progress",
            status: "warn",
            detail: `${locked.length} app(s) are being deployed right now (${locked.map((id) => facts.apps.find((app) => app.id === id)?.name ?? id).join(", ")}).`,
            remediation: "Wait for the deployment to finish so the export captures a settled state."
          }
    )
  );

  if (input.scope === "platform") {
    const last = facts.lastUpdate;
    checks.push(
      check(
        last && IN_FLIGHT_UPDATE.has(last.result)
          ? {
              id: "source.activity.updater",
              title: "No platform update in progress",
              status: "warn",
              detail: `A platform update to ${last.toVersion} is in progress (${last.result}).`,
              remediation: "Wait for it to finish; pause the updater for the duration of a migration."
            }
          : last && STUCK_UPDATE.has(last.result)
            ? {
                id: "source.activity.updater",
                title: "No platform update in progress",
                status: "warn",
                detail: `The last update attempt (${last.toVersion}) ended as "${last.result}".`,
                remediation: "Resolve the update state before migrating, and pause the updater for the duration."
              }
            : {
                id: "source.activity.updater",
                title: "No platform update in progress",
                status: "pass",
                detail: last ? `The last update attempt (${last.toVersion}) ended as "${last.result}".` : "No update history."
              }
      )
    );
  }

  const cronEnabled = subjects.reduce((sum, app) => sum + app.cronJobs.filter((job) => job.enabled).length, 0);
  const autoDeploy = subjects.filter((app) => app.source?.autoDeploy).length;
  const healthChecks = subjects.filter((app) => app.healthCheck?.enabled).length;
  checks.push(
    check({
      id: "source.schedulers",
      title: "Scheduled activity that cutover must pause",
      status: "info",
      detail: `${cronEnabled} enabled cron job(s), ${autoDeploy} auto-deploy app(s), ${healthChecks} health check(s). They are fenced at cutover so nothing runs on two servers.`
    })
  );

  // --- size & space ----------------------------------------------------------------
  const requirements = requirementsFromFacts({
    facts,
    scope: input.scope,
    operation: input.operation,
    appIds: subjects.map((app) => app.id),
    usage,
    localImageTags: localTags,
    platformVersion: input.platformVersion,
    arch: info.arch,
    sourceCredentialKeyId: input.encryption.available ? credentialKeyId(input.encryption.key) : null
  });
  sections.estimates = {
    transferBytes: requirements.totalBytes,
    unknownSizeItems: requirements.unknownSizeItems,
    requiredFreeBytes: requirements.totalBytes === null ? null : requiredDiskBytes(requirements.totalBytes)
  };

  if (requirements.totalBytes === null || input.outputFreeBytes === null || input.outputFreeBytes === undefined) {
    checks.push(
      check({
        id: "source.disk.space",
        title: "Enough free space for the export",
        status: "skip",
        detail:
          requirements.totalBytes === null
            ? "The size of the data to export could not be determined."
            : `The export needs about ${formatBytes(requiredDiskBytes(requirements.totalBytes))}; pass --output-dir (or --output-free-bytes) to check free space.`
      })
    );
  } else {
    const required = requiredDiskBytes(requirements.totalBytes);
    const free = input.outputFreeBytes;
    const status = free < required ? "fail" : free < required * 1.5 ? "warn" : "pass";
    checks.push(
      check({
        id: "source.disk.space",
        title: "Enough free space for the export",
        status,
        detail:
          `The export needs about ${formatBytes(required)}; ${formatBytes(free)} is free${input.outputFreeSource ? ` (${input.outputFreeSource})` : ""}.` +
          (requirements.unknownSizeItems > 0 ? ` ${requirements.unknownSizeItems} item(s) could not be sized.` : ""),
        remediation: status === "pass" ? undefined : `Free at least ${formatBytes(Math.max(required - free, 0))}, or write the bundle to a larger disk.`,
        data: { requiredBytes: required, freeBytes: free }
      })
    );
  }

  checks.push(
    check({
      id: "source.bundle.encryption",
      title: "The bundle will be fully encrypted",
      status: "info",
      detail:
        "Every artifact — database, configuration, volumes and images — and the manifest are encrypted (AES-256-GCM). " +
        "A passphrase of at least 12 characters is required and is never accepted on the command line."
    })
  );

  // --- application scope: dependencies & side effects -------------------------------
  if (input.scope === "application" && application) {
    const analysis: DependencyAnalysis = analyzeDependencies(facts, application.id, {
      operation: input.operation === "backup" ? "copy" : input.operation,
      selection: input.selection
    });
    sections.dependencies = analysis;
    checks.push(
      check(
        analysis.blockers > 0
          ? {
              id: "source.dependencies",
              title: "Dependencies are resolved",
              status: "fail",
              detail: `${analysis.blockers} unresolved dependency issue(s): ${analysis.findings
                .filter((finding) => finding.severity === "blocker")
                .map((finding) => `${finding.name} (${finding.evidence.split(".")[0]})`)
                .join("; ")}.`,
              remediation:
                analysis.suggestedAdditions.length > 0
                  ? `Include ${analysis.suggestedAdditions.join(", ")} in this migration, or reconfigure the references.`
                  : "Reconfigure the references shown in the dependency analysis.",
              data: { blockers: analysis.blockers, warnings: analysis.warnings }
            }
          : analysis.warnings > 0
            ? {
                id: "source.dependencies",
                title: "Dependencies are resolved",
                status: "warn",
                detail: `No blockers, but ${analysis.warnings} item(s) need your attention: ${analysis.findings
                  .filter((finding) => finding.severity === "warning")
                  .map((finding) => `${finding.name} (${finding.evidence.split(". ")[0]?.replace(/\.$/, "")})`)
                  .join("; ")}.`,
                remediation: "Review the dependency analysis before continuing.",
                data: { blockers: 0, warnings: analysis.warnings }
              }
            : { id: "source.dependencies", title: "Dependencies are resolved", status: "pass", detail: "No unresolved dependencies." }
      )
    );
    checks.push(
      check({
        id: "source.sideeffects",
        title: "Side effects a non-owner copy must keep off",
        status: analysis.sideEffects.length > 0 ? "info" : "pass",
        detail:
          analysis.sideEffects.length === 0
            ? "None found."
            : analysis.sideEffects.map((effect) => `${effect.kind}: ${effect.names.join(", ")}`).join("; ") +
              ". These stay disabled on any copy that is not the live owner."
      })
    );
  }

  // --- evaluate against a described destination -----------------------------------------
  sections.requirements = requirements;
  if (input.destination) {
    checks.push(...evaluateDestination(requirements, input.destination));
    sections.destination = {
      serverId: input.destination.server.serverId,
      hostname: input.destination.server.hostname,
      platformVersion: input.destination.platform.version
    };
  } else {
    // A plain backup needs no destination. A copy or move is not "ready" until one has been checked.
    const needsDestination = input.operation !== "backup";
    checks.push(
      check({
        id: "destination.evaluated",
        title: "Destination compatibility",
        status: needsDestination ? "warn" : "skip",
        detail:
          "No destination was described, so compatibility, free space and name collisions on the destination have not been checked.",
        remediation: needsDestination
          ? "Run `migrate describe` on the destination and pass the result with --destination-descriptor."
          : undefined
      })
    );
  }

  return finish(application);
}


/** The two bundle properties as report checks. Integrity and authenticity stay separate. */
export function bundleVerificationChecks(verification: BundleVerification): CheckResult[] {
  const { integrity, authenticity } = verification;

  return [
    check(
      integrity.status === "verified"
        ? {
            id: "bundle.integrity",
            title: "Bundle integrity",
            status: "pass",
            detail: `Verified (${integrity.depth}): ${integrity.artifactsChecked} artifact(s) checked${integrity.depth === "structure" ? "; run with --deep to authenticate every byte" : ""}.`
          }
        : {
            id: "bundle.integrity",
            title: "Bundle integrity",
            status: "fail",
            detail: integrity.problems.map((problem) => problem.message).join(" "),
            remediation: "Do not use this bundle. Re-transfer it, or re-export from the source."
          }
    ),
    check(
      authenticity.status === "origin-verified"
        ? { id: "bundle.authenticity", title: "Bundle authenticity", status: "pass", detail: authenticity.notes.join(" ") }
        : authenticity.status === "passphrase-only"
          ? {
              id: "bundle.authenticity",
              title: "Bundle authenticity",
              status: "warn",
              detail: authenticity.notes.join(" "),
              remediation: "Pin the source's signer fingerprint with --expect-signer to establish where this bundle came from."
            }
          : authenticity.status === "not-checked"
            ? { id: "bundle.authenticity", title: "Bundle authenticity", status: "skip", detail: authenticity.notes.join(" ") }
            : {
                id: "bundle.authenticity",
                title: "Bundle authenticity",
                status: "fail",
                detail: authenticity.notes.join(" "),
                remediation: "Do not use this bundle unless you can explain the signature failure."
              }
    )
  ];
}

/** Verifies a bundle on its own (no destination needed) and reports both properties. */
export async function runBundleVerification(input: {
  directory: string;
  passphrase: string;
  options?: VerifyOptions;
  now?: Date;
}): Promise<VerificationReport> {
  const verification = await verifyBundle(input.directory, input.passphrase, input.options);
  const manifest = verification.manifest;

  return buildReport({
    kind: "bundle-verification",
    role: "destination",
    scope: manifest?.scope ?? "platform",
    checks: bundleVerificationChecks(verification),
    integrity: verification.integrity,
    authenticity: verification.authenticity,
    sections: manifest
      ? {
          bundle: {
            bundleId: manifest.bundleId,
            createdAt: manifest.createdAt,
            scope: manifest.scope,
            operation: manifest.transfer.operation,
            consistencyMode: manifest.consistency.mode,
            apps: manifest.apps.map((app) => app.name),
            artifacts: manifest.artifacts.length
          }
        }
      : {},
    now: input.now
  });
}

// ------------------------------------------------------- destination preflight ----

export interface DestinationPreflightInput {
  descriptor: DestinationDescriptor;
  bundle?: { directory: string; passphrase: string } & VerifyOptions;
  now?: Date;
}

export async function runDestinationPreflight(input: DestinationPreflightInput): Promise<VerificationReport> {
  const checks: CheckResult[] = [];
  const sections: Record<string, unknown> = {};
  const { descriptor } = input;

  sections.destination = {
    serverId: descriptor.server.serverId,
    hostname: descriptor.server.hostname,
    platformVersion: descriptor.platform.version,
    schemaVersion: descriptor.platform.schemaVersion,
    freeDiskBytes: descriptor.server.freeDiskBytes
  };

  if (!input.bundle) {
    checks.push(
      check({
        id: "destination.platform.installed",
        title: "Destination runs ClovaForge",
        status: descriptor.platform.installed ? "pass" : "fail",
        detail: descriptor.platform.installed
          ? `ClovaForge ${descriptor.platform.version} (schema v${descriptor.platform.schemaVersion}).`
          : "No ClovaForge installation was found.",
        remediation: descriptor.platform.installed ? undefined : "Install ClovaForge first."
      }),
      check({
        id: "destination.bundle.supplied",
        title: "A bundle to check",
        status: "skip",
        detail: "No bundle was given. Pass --bundle and --passphrase-file to verify a bundle and plan its import."
      })
    );

    return buildReport({ kind: "preflight", role: "destination", scope: "platform", checks, sections, now: input.now });
  }

  const verification = await verifyBundle(input.bundle.directory, input.bundle.passphrase, input.bundle);
  const { integrity, authenticity, manifest } = verification;

  checks.push(...bundleVerificationChecks(verification));

  if (!manifest) {
    return buildReport({ kind: "preflight", role: "destination", scope: "platform", checks, integrity, authenticity, sections, now: input.now });
  }

  sections.bundle = {
    bundleId: manifest.bundleId,
    createdAt: manifest.createdAt,
    scope: manifest.scope,
    operation: manifest.transfer.operation,
    sourcePlatformVersion: manifest.source.platformVersion,
    apps: manifest.apps.map((app) => ({ ref: app.ref, name: app.name, volumes: app.volumes.length, images: app.images.length })),
    artifacts: manifest.artifacts.length
  };

  // Consistency recorded in the bundle, judged honestly.
  const accepted = new Set(manifest.consistency.acceptedRisks.map((risk) => risk.subject));
  const weak = manifest.apps.flatMap((app) =>
    app.volumes
      .filter((volume) => volume.consistency.level !== "application-consistent" && volume.consistency.level !== "not-applicable")
      .map((volume) => ({ app, volume }))
  );
  const unaccepted = weak.filter(({ app }) => !accepted.has(app.ref));
  const inconsistent = weak.filter(({ volume }) => volume.consistency.level === "inconsistent");
  const mode = manifest.consistency.mode;

  checks.push(
    check(
      weak.length === 0
        ? {
            id: "bundle.consistency",
            title: "Recorded data consistency",
            status: "pass",
            detail: "Every volume was captured with application-level evidence (or has no persistent state)."
          }
        : mode === "cutover" && (inconsistent.length > 0 || unaccepted.length > 0)
          ? {
              id: "bundle.consistency",
              title: "Recorded data consistency",
              status: "fail",
              detail:
                `This cutover bundle holds ${weak.length} volume(s) that are not application-consistent` +
                (inconsistent.length > 0 ? `, ${inconsistent.length} of them captured live with no quiesce` : "") +
                `, without a recorded risk acceptance: ${unaccepted.map(({ app, volume }) => `${app.name}/${volume.name} (${volume.consistency.level})`).join(", ")}.`,
              remediation: "Re-export with application-level evidence, or record an explicit risk acceptance per app."
            }
          : mode === "rehearsal"
            ? {
                id: "bundle.consistency",
                title: "Recorded data consistency",
                status: "warn",
                detail: `This is a rehearsal bundle: ${weak.length} volume(s) are not application-consistent (${[...new Set(weak.map(({ volume }) => volume.consistency.level))].join(", ")}). It is suitable for testing, not for cutover.`,
                remediation: "Create a cutover-grade export before switching production traffic."
              }
            : {
                id: "bundle.consistency",
                title: "Recorded data consistency",
                status: "warn",
                detail: `${weak.length} volume(s) are not application-consistent, but their risk was explicitly accepted at export time.`
              }
    )
  );

  const requirements = requirementsFromManifest(manifest);
  checks.push(...evaluateDestination(requirements, descriptor));

  const plan = planImport(manifest, descriptor);
  sections.plan = plan;
  checks.push(
    check(
      plan.executable
        ? {
            id: "destination.plan",
            title: "Import plan has no conflicts",
            status: "pass",
            detail: `${plan.counts.create} to create, ${plan.counts.resume} to resume, ${plan.counts["already-applied"]} already applied. Nothing existing will be overwritten.`
          }
        : {
            id: "destination.plan",
            title: "Import plan has no conflicts",
            status: "fail",
            detail: `${plan.counts.conflict} resource(s) already exist and were not created by this migration: ${plan.steps
              .filter((step) => step.action === "conflict")
              .map((step) => step.resource)
              .join(", ")}. They will not be overwritten.`,
            remediation: "Rename or remove them deliberately, or import into a clean destination."
          }
    )
  );

  return buildReport({
    kind: "preflight",
    role: "destination",
    scope: manifest.scope,
    checks,
    integrity,
    authenticity,
    sections,
    now: input.now
  });
}

/** Builds this server's descriptor from read-only sources. */
export async function describeServer(input: {
  docker: ReadOnlyDockerProbe;
  facts: PlatformFacts | null;
  platformVersion: string;
  maxSchemaVersion: number;
  encryption: EncryptionKeyStatus;
  diskPath: string | null;
  now?: Date;
}): Promise<DestinationDescriptor> {
  const info = await input.docker.info();
  const [containers, volumes, images] = await Promise.all([
    input.docker.listContainers(),
    input.docker.listVolumes(),
    input.docker.listImages()
  ]);

  return buildDescriptor({
    host: collectHostFacts(info, input.diskPath),
    platformVersion: input.platformVersion,
    facts: input.facts,
    maxSchemaVersion: input.maxSchemaVersion,
    keyId: input.encryption.available ? credentialKeyId(input.encryption.key) : null,
    containers,
    volumes,
    images,
    now: input.now
  });
}
