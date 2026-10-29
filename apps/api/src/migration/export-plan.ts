import {
  ceilingWithoutEvidence,
  classifyDataProfile,
  evaluateConsistencyPolicy,
  meetsLevel,
  type ConsistencyLevel,
  type DataProfile,
  type ExportMode,
  type SnapshotStrategy
} from "./consistency.js";
import type { UnexportedItem } from "./app-definition.js";
import { analyzeDependencies, findAppDependencies, type Operation } from "./dependencies.js";
import { isLocalBuildTag } from "./destination.js";
import type { ExportContainerInfo } from "./export-docker.js";
import { appRef, type AppFacts, type PlatformFacts } from "./facts.js";
import { hookCovers, presetFor, type HookDefinition, type HooksFile } from "./hooks.js";
import type { DiskUsage } from "./probes.js";
import { formatBytes } from "./report.js";

/**
 * Decides HOW an export will run, before anything is touched.
 *
 * The planner is pure. Its most important job is to REFUSE early: every condition
 * that would make an export unacceptable — a database with no verifiable evidence
 * at cutover, an unresolved dependency, a bind mount that cannot be carried, not
 * enough disk — is found here, while every app is still running, so a refusal never
 * costs anyone any downtime.
 */

export type StrategyChoice = "auto" | SnapshotStrategy;

export interface ExportOptions {
  scope: "platform" | "application";
  operation: Operation | "backup";
  mode: ExportMode;
  appId?: number;
  /** Apps migrating together with `appId`. */
  selection: number[];
  strategies: { default: StrategyChoice; perApp: Record<string, SnapshotStrategy> };
  hooks: HooksFile;
  /** App name or ref → the weakest level the operator accepts for that app. */
  acceptRisks: Record<string, ConsistencyLevel>;
  quiesce: "group" | "sequential";
  /** Allow cutover even though some mounts cannot be carried (bind mounts, unrecorded volumes). */
  allowUnexported: boolean;
  /** Also carry registry images that exist locally (rollback images are always carried). */
  includeRegistryImages: boolean;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  scope: "platform",
  operation: "backup",
  mode: "rehearsal",
  selection: [],
  strategies: { default: "auto", perApp: {} },
  hooks: {},
  acceptRisks: {},
  quiesce: "group",
  allowUnexported: false,
  includeRegistryImages: false
};

export interface PlanInput {
  facts: PlatformFacts;
  /** App id → its container (null if it does not exist). */
  containers: Map<number, ExportContainerInfo | null>;
  usage: DiskUsage;
  localImageTags: Set<string>;
  options: ExportOptions;
  /** Size of the platform database file, if known. */
  dbSizeBytes: number | null;
  /** Whether the host config / proxy-route directories are readable. */
  hostPaths: { config: boolean; routes: boolean };
  outputFreeBytes: number | null;
}

export interface VolumePlan {
  appRef: string;
  volumeName: string;
  containerPath: string;
  sizeBytes: number | null;
  method: "tar" | "dump";
  strategy: SnapshotStrategy;
  /** Best level this plan can reach. */
  expectedLevel: ConsistencyLevel;
  /** True if the level depends on evidence gathered at run time (e.g. a PostgreSQL shutdown check). */
  conditional: boolean;
  hook: HookDefinition | null;
  shutdownCheck: "postgres" | null;
}

export interface ImagePlan {
  tag: string;
  role: "current" | "rollback" | "dependency";
  sizeBytes: number | null;
}

export interface AppPlan {
  ref: string;
  id: number;
  name: string;
  containerName: string;
  running: boolean;
  profile: DataProfile;
  strategy: SnapshotStrategy;
  volumes: VolumePlan[];
  images: ImagePlan[];
  unexported: UnexportedItem[];
  /** Level the operator accepted for this app, if acceptance is what lets the export proceed. */
  acceptedRisk: ConsistencyLevel | null;
}

export interface Refusal {
  code:
    | "consistency-evidence-required"
    | "live-copy-not-allowed"
    | "hook-unavailable"
    | "hook-not-covering"
    | "app-not-running"
    | "unresolved-dependencies"
    | "unexported-mounts"
    | "insufficient-disk"
    | "config-unavailable"
    | "deployment-in-progress"
    | "unknown-app";
  subject?: string;
  message: string;
  remedy: string;
}

export interface QuiesceWindow {
  /** App refs in the order they are quiesced (dependents first). Restored in reverse. */
  apps: string[];
}

export interface ExportPlan {
  scope: ExportOptions["scope"];
  operation: ExportOptions["operation"];
  mode: ExportMode;
  apps: AppPlan[];
  windows: QuiesceWindow[];
  platform: { database: boolean; config: boolean; routes: boolean };
  estimates: { upperBoundBytes: number; unknownSizeItems: number; requiredFreeBytes: number };
  refusals: Refusal[];
  warnings: string[];
}

const MIB = 1024 * 1024;
export const DEFINITION_ALLOWANCE_BYTES = 1 * MIB;
export const DISK_MARGIN_BYTES = 256 * MIB;
export const GZIP_OVERHEAD = 1.02;

const keysFor = (app: Pick<AppFacts, "id" | "name">): string[] => [app.name, appRef(app.id)];
const lookup = <T>(record: Record<string, T>, app: Pick<AppFacts, "id" | "name">): T | undefined => {
  for (const key of keysFor(app)) {
    if (key in record) {
      return record[key];
    }
  }

  return undefined;
};

function unexportedFor(app: AppFacts, container: ExportContainerInfo | null): UnexportedItem[] {
  if (!container) {
    return [];
  }

  const recorded = new Set(app.volumes.map((volume) => volume.volumeName));
  const items: UnexportedItem[] = [];

  for (const mount of container.mounts) {
    if (mount.type === "bind") {
      items.push({
        kind: "bind-mount",
        destination: mount.destination,
        detail: "A host directory is mounted here. Host paths are not part of ClovaForge-managed state and are not exported."
      });
    } else if (mount.type === "volume" && mount.name !== null && !recorded.has(mount.name)) {
      items.push({
        kind: "unrecorded-volume",
        destination: mount.destination,
        detail: "A Docker volume is mounted here that ClovaForge has no record of, so it is not exported."
      });
    }
  }

  return items;
}

/** Orders apps so that anything that USES another app is stopped before it. */
export function stopOrder(facts: PlatformFacts, ids: number[]): number[] {
  const chosen = new Set(ids);
  const uses = new Map<number, Set<number>>(); // app -> apps it uses (within the selection)
  for (const id of ids) {
    uses.set(id, new Set(findAppDependencies(facts, id).strong.filter((dep) => chosen.has(dep))));
  }

  const remaining = new Set(ids);
  const order: number[] = [];

  while (remaining.size > 0) {
    // Safe to stop now: no remaining app still uses it.
    const free = [...remaining].filter((id) => ![...remaining].some((other) => other !== id && uses.get(other)?.has(id)));
    const next = (free.length > 0 ? free : [...remaining]).sort((a, b) => a - b);
    // Take dependents first: pick those that use something, else lowest id.
    const pick = next.find((id) => (uses.get(id)?.size ?? 0) > 0) ?? next[0]!;
    order.push(pick);
    remaining.delete(pick);
  }

  return order;
}

export function planExport(input: PlanInput): ExportPlan {
  const { facts, options } = input;
  const refusals: Refusal[] = [];
  const warnings: string[] = [];

  let subjects: AppFacts[] = facts.apps;
  if (options.scope === "application") {
    const target = facts.apps.find((app) => app.id === options.appId);
    if (!target) {
      return {
        scope: options.scope,
        operation: options.operation,
        mode: options.mode,
        apps: [],
        windows: [],
        platform: { database: false, config: false, routes: false },
        estimates: { upperBoundBytes: 0, unknownSizeItems: 0, requiredFreeBytes: 0 },
        refusals: [
          {
            code: "unknown-app",
            message: `No application with id ${options.appId ?? "(none)"} exists.`,
            remedy: "Pass a valid application id or name."
          }
        ],
        warnings
      };
    }
    const together = new Set([target.id, ...options.selection]);
    subjects = facts.apps.filter((app) => together.has(app.id));
  }

  const apps: AppPlan[] = [];
  let upper = 0;
  let unknown = 0;

  for (const app of subjects) {
    const ref = appRef(app.id);
    const container = input.containers.get(app.id) ?? null;
    const running = container?.running === true && !container.paused;
    const profile = classifyDataProfile({
      image: app.image,
      mountPaths: app.volumes.map((volume) => volume.containerPath),
      envKeys: app.env.map((entry) => entry.key),
      hasVolumes: app.volumes.length > 0
    });
    const customHook = lookup(options.hooks, app) ?? null;
    const hook = customHook ?? presetFor(profile.kind);
    const hookCoversAll = hook !== null && app.volumes.every((volume) => hookCovers(hook, volume.containerPath));

    // ---- choose the strategy -------------------------------------------------
    const requested = lookup(options.strategies.perApp, app) ?? options.strategies.default;
    let strategy: SnapshotStrategy;

    if (app.volumes.length === 0) {
      strategy = "none";
    } else if (requested !== "auto") {
      strategy = requested;
    } else if (hook && hookCoversAll && running) {
      strategy = "hook";
    } else {
      strategy = options.mode === "cutover" ? "stop" : "live";
    }

    if (strategy === "hook") {
      if (!hook) {
        refusals.push({
          code: "hook-unavailable",
          subject: ref,
          message: `"${app.name}" has no snapshot hook: no built-in one exists for ${profile.kind}, and none was supplied.`,
          remedy: "Supply a hook with --hooks-file (it must state how its output is verified), or choose another strategy."
        });
      } else if (!hookCoversAll) {
        refusals.push({
          code: "hook-not-covering",
          subject: ref,
          message: `The ${hook.id} hook does not cover every volume of "${app.name}": ${app.volumes
            .filter((volume) => !hookCovers(hook, volume.containerPath))
            .map((volume) => volume.containerPath)
            .join(", ")}.`,
          remedy: 'Extend the hook\'s "covers" list, or use the stop strategy for this app.'
        });
      } else if (!running) {
        refusals.push({
          code: "app-not-running",
          subject: ref,
          message: `"${app.name}" is not running, so a dump cannot be taken from it.`,
          remedy: "Start the app, or use the stop strategy (its volumes are already quiescent)."
        });
      }
    }
    if ((strategy === "freeze" || strategy === "hook") && container === null && app.volumes.length > 0) {
      refusals.push({
        code: "app-not-running",
        subject: ref,
        message: `The container for "${app.name}" does not exist.`,
        remedy: "Redeploy the app, or export it with the stop strategy (its volumes are read as they are)."
      });
    }

    // ---- what each volume will be ----------------------------------------------
    const volumes: VolumePlan[] = app.volumes.map((volume) => {
      const sizeBytes = input.usage.volumeSizes.get(volume.volumeName) ?? null;
      if (sizeBytes === null) {
        unknown += 1;
      } else {
        upper += sizeBytes;
      }

      const isDump = strategy === "hook" && hook !== null;
      const shutdownCheck = strategy === "stop" && profile.kind === "postgres" ? ("postgres" as const) : null;
      const expectedLevel: ConsistencyLevel = isDump
        ? "application-consistent"
        : shutdownCheck
          ? "application-consistent"
          : strategy === "none"
            ? "not-applicable"
            : ceilingWithoutEvidence(strategy);

      return {
        appRef: ref,
        volumeName: volume.volumeName,
        containerPath: volume.containerPath,
        sizeBytes,
        method: isDump ? ("dump" as const) : ("tar" as const),
        strategy,
        expectedLevel,
        conditional: shutdownCheck !== null,
        hook: isDump ? hook : null,
        shutdownCheck
      };
    });

    // ---- the consistency policy ------------------------------------------------
    let acceptedRisk: ConsistencyLevel | null = null;
    if (profile.hasPersistentState && strategy !== "none") {
      // Judge the BEST case now; conditional upgrades are re-checked at run time.
      const best = volumes.reduce<ConsistencyLevel>(
        (level, volume) => (meetsLevel(volume.expectedLevel, level) ? level : volume.expectedLevel),
        "application-consistent"
      );
      const accepted = lookup(options.acceptRisks, app);
      const isAccepted = accepted !== undefined && meetsLevel(best, accepted);
      const verdict = evaluateConsistencyPolicy({ profile, level: best, mode: options.mode, accepted: isAccepted });

      if (!verdict.allowed) {
        refusals.push(
          best === "inconsistent"
            ? {
                code: "live-copy-not-allowed",
                subject: ref,
                message: `"${app.name}": a live, unquiesced copy cannot be used for cutover.`,
                remedy: "Use the hook strategy (verified dump) or the stop strategy."
              }
            : {
                code: "consistency-evidence-required",
                subject: ref,
                message:
                  `"${app.name}" looks like ${profile.isDatabase ? `a ${profile.kind} database` : "an app with data of unknown type"}, ` +
                  `and this strategy can establish only "${best}" — not application consistency.`,
                remedy:
                  `${profile.recommendation} Or accept the risk for this app explicitly: ` +
                  `--accept-risk ${app.name}=${best}.`
              }
        );
      } else if (verdict.severity === "warn" && options.mode === "cutover") {
        acceptedRisk = accepted ?? null;
      }
      if (options.mode === "rehearsal" && best !== "application-consistent") {
        warnings.push(`"${app.name}" will be captured as ${best}: fine for a rehearsal, not for cutover.`);
      }
    }

    // ---- unexported mounts --------------------------------------------------------
    const unexported = unexportedFor(app, container);
    if (unexported.length > 0) {
      const listing = unexported.map((item) => `${item.destination} (${item.kind})`).join(", ");
      if (options.mode === "cutover" && !options.allowUnexported) {
        refusals.push({
          code: "unexported-mounts",
          subject: ref,
          message: `"${app.name}" uses data this export cannot carry: ${listing}.`,
          remedy: "Move that data into a named ClovaForge volume, or pass --allow-unexported to accept that it is left behind."
        });
      } else {
        warnings.push(`"${app.name}" uses data that is NOT exported: ${listing}.`);
      }
    }

    // ---- a deployment in flight would change the app mid-export --------------------------
    if (facts.activeDeploymentLockAppIds.includes(app.id)) {
      if (options.mode === "cutover") {
        refusals.push({
          code: "deployment-in-progress",
          subject: ref,
          message: `"${app.name}" is being deployed right now.`,
          remedy: "Wait for the deployment to finish, then export."
        });
      } else {
        warnings.push(`"${app.name}" is being deployed right now; the export may capture a half-finished state.`);
      }
    }

    // ---- images --------------------------------------------------------------------
    const images: ImagePlan[] = [];
    const seen = new Set<string>();
    for (const deployment of app.deployments) {
      if (seen.has(deployment.imageTag) || !isLocalBuildTag(deployment.imageTag) || !input.localImageTags.has(deployment.imageTag)) {
        continue;
      }
      seen.add(deployment.imageTag);
      const sizeBytes = input.usage.imageSizes.get(deployment.imageTag) ?? null;
      images.push({ tag: deployment.imageTag, role: deployment.isCurrent ? "current" : "rollback", sizeBytes });
    }
    if (options.includeRegistryImages && !seen.has(app.image) && input.localImageTags.has(app.image)) {
      images.push({ tag: app.image, role: "dependency", sizeBytes: input.usage.imageSizes.get(app.image) ?? null });
    }
    for (const image of images) {
      if (image.sizeBytes === null) {
        unknown += 1;
      } else {
        upper += image.sizeBytes;
      }
    }
    upper += DEFINITION_ALLOWANCE_BYTES;

    apps.push({
      ref,
      id: app.id,
      name: app.name,
      containerName: app.containerName,
      running,
      profile,
      strategy,
      volumes,
      images,
      unexported,
      acceptedRisk
    });
  }

  // ---- dependencies (a copy or move needs them resolved) --------------------------------
  if (options.scope === "application" && options.appId !== undefined) {
    const analysis = analyzeDependencies(facts, options.appId, {
      operation: options.operation === "backup" ? "copy" : options.operation,
      selection: options.selection
    });
    if (analysis.blockers > 0) {
      const message = `Unresolved dependencies: ${analysis.findings
        .filter((finding) => finding.severity === "blocker")
        .map((finding) => finding.name)
        .join(", ")}.`;
      if (options.operation === "backup") {
        warnings.push(message);
      } else {
        refusals.push({
          code: "unresolved-dependencies",
          message,
          remedy:
            analysis.suggestedAdditions.length > 0
              ? `Include ${analysis.suggestedAdditions.join(", ")} (--with), or reconfigure the references.`
              : "Reconfigure the references shown by `migrate preflight`."
        });
      }
    }
    for (const effect of analysis.sideEffects.filter((entry) => entry.kind === "external-database")) {
      warnings.push(`An external database is shared (${effect.names.join(", ")}); a copy must stay dormant until promoted.`);
    }
  }

  // ---- quiesce windows -------------------------------------------------------------------
  const disruptive = apps.filter((app) => app.strategy === "stop" || app.strategy === "freeze");
  const ordered = stopOrder(
    facts,
    disruptive.map((app) => app.id)
  );
  const windows: QuiesceWindow[] =
    options.quiesce === "group"
      ? ordered.length > 0
        ? [{ apps: ordered.map(appRef) }]
        : []
      : ordered.map((id) => ({ apps: [appRef(id)] }));

  // ---- platform artifacts ------------------------------------------------------------------
  const platform = {
    database: options.scope === "platform",
    config: options.scope === "platform" && input.hostPaths.config,
    routes: options.scope === "platform" && input.hostPaths.routes
  };
  if (options.scope === "platform") {
    if (!input.hostPaths.config) {
      refusals.push({
        code: "config-unavailable",
        message: "The platform configuration directory (secrets, including the credential encryption key) is not readable.",
        remedy: "Run the export through `deployment-platform migrate export`, which mounts it read-only."
      });
    }
    if (!input.hostPaths.routes) {
      warnings.push("The proxy routes directory is not readable; routes will be regenerated on the destination.");
    }
    upper += (input.dbSizeBytes ?? 0) + 2 * MIB;
  }

  // ---- disk -------------------------------------------------------------------------------------
  const requiredFreeBytes = Math.ceil(upper * GZIP_OVERHEAD) + (input.dbSizeBytes ?? 0) + DISK_MARGIN_BYTES;
  if (input.outputFreeBytes !== null && input.outputFreeBytes < requiredFreeBytes) {
    refusals.push({
      code: "insufficient-disk",
      message: `The export needs up to ${formatBytes(requiredFreeBytes)} but only ${formatBytes(input.outputFreeBytes)} is free where it would be written.`,
      remedy: `Free at least ${formatBytes(requiredFreeBytes - input.outputFreeBytes)}, or write the bundle to a larger disk.`
    });
  }
  if (unknown > 0) {
    warnings.push(`${unknown} item(s) could not be sized, so the disk estimate is a lower bound; free space is re-checked during the export.`);
  }

  return {
    scope: options.scope,
    operation: options.operation,
    mode: options.mode,
    apps,
    windows,
    platform,
    estimates: { upperBoundBytes: upper, unknownSizeItems: unknown, requiredFreeBytes },
    refusals,
    warnings
  };
}
