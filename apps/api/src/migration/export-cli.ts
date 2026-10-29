import { createPrivateKey, createPublicKey } from "node:crypto";
import { CONSISTENCY_LEVELS, type ConsistencyLevel, type SnapshotStrategy } from "./consistency.js";
import { EXIT_BLOCKED, EXIT_EXPORT_FAILED, EXIT_READY, EXIT_RESTORE_FAILED, EXIT_WARNINGS } from "./constants.js";
import type { CliEnvironment, CliResult } from "./cli.js";
import type { ExportDockerClient } from "./export-docker.js";
import {
  buildExportReport,
  defaultRunOptions,
  ExportBusyError,
  ExportFailedError,
  ExportRefusedError,
  runExport
} from "./export.js";
import { recoverDisruptions } from "./export-journal.js";
import { DEFAULT_OPTIONS, planExport, type ExportOptions, type StrategyChoice } from "./export-plan.js";
import type { PlatformFacts } from "./facts.js";
import { parseHooksFile } from "./hooks.js";
import type { ExportContainerInfo } from "./export-docker.js";
import { deriveServerId } from "./probes.js";
import { runSourcePreflight } from "./preflight.js";
import { renderReportText, formatBytes } from "./report.js";
import { fingerprintOf, generateSigningKeyPair } from "./signing.js";

/**
 * `export`, `recover` and `signing-key`: the Phase 1 commands.
 *
 * `export` READS the installation and writes one new encrypted bundle. It may briefly stop or
 * pause an app to take a consistent snapshot and always restarts it. It never imports,
 * restores, replaces or hands over anything.
 */

export class ExportUsageError extends Error {}

export interface ExportEnvironment {
  createClient(): ExportDockerClient;
  /** Host configuration (mounted read-only), or null if not available. */
  configDir: string | null;
  routesDir: string | null;
  /** Where the recovery journal lives. */
  stateDir: string;
  /** A local image for volume-reading helper containers. */
  helperImage: string | null;
  /** Aborted on Ctrl-C / SIGTERM: the export then fails SAFELY and restores everything. */
  signal?: AbortSignal;
  log(message: string): void;
  /** Creates a NEW file (never overwrites). */
  writeNewFile(path: string, content: string, mode: number): void;
  readSigningKey(path: string): string;
  dbSize(path: string): number | null;
}

/** The option values the export commands read (a structural subset of the CLI's parsed values). */
export interface ExportValues {
  scope?: string;
  app?: string;
  with?: string[];
  operation?: string;
  mode?: string;
  strategy?: string;
  "app-strategy"?: string[];
  "hooks-file"?: string;
  "accept-risk"?: string[];
  quiesce?: string;
  "allow-unexported"?: boolean;
  "include-registry-images"?: boolean;
  "signing-key-file"?: string;
  verify?: string;
  "bundle-name"?: string;
  "output-dir"?: string;
  "passphrase-file"?: string;
  "helper-image"?: string;
  "grace-seconds"?: string;
  "max-disruption-minutes"?: string;
  "gzip-level"?: string;
  "db-path"?: string;
  format?: string;
  force?: boolean;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, flag: string): T {
  if (value === undefined) {
    return fallback;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ExportUsageError(`${flag} must be one of: ${allowed.join(", ")}.`);
  }

  return value as T;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, flag: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ExportUsageError(`${flag} must be a whole number from ${min} to ${max}.`);
  }

  return parsed;
}

function pairs(entries: string[] | undefined, flag: string): Array<[string, string]> {
  return (entries ?? []).map((entry) => {
    const index = entry.lastIndexOf("=");
    if (index <= 0 || index === entry.length - 1) {
      throw new ExportUsageError(`${flag} expects NAME=VALUE (got "${entry}").`);
    }

    return [entry.slice(0, index), entry.slice(index + 1)];
  });
}

const STRATEGIES = ["auto", "stop", "freeze", "live", "hook"] as const;

function emitText(exitCode: number, text: string): CliResult {
  return { exitCode, stdout: `${text}\n`, stderr: "" };
}

// ------------------------------------------------------------------- export ----

export async function runExportCommand(
  values: ExportValues,
  env: CliEnvironment,
  ex: ExportEnvironment,
  resolveApp: (facts: PlatformFacts, reference: string) => number
): Promise<CliResult> {
  if (!values["output-dir"] || !values["passphrase-file"]) {
    throw new ExportUsageError("export needs --output-dir (where the bundle is written) and --passphrase-file.");
  }

  const dbPath = values["db-path"] ?? env.defaultDbPath;
  if (!env.fileExists(dbPath)) {
    throw new ExportUsageError(`No platform database was found at ${dbPath}.`);
  }

  const scope = oneOf(values.scope, ["platform", "application"] as const, "platform", "--scope");
  const operation = oneOf(values.operation, ["backup", "copy", "move"] as const, scope === "application" ? "copy" : "backup", "--operation");
  const mode = oneOf(values.mode, ["rehearsal", "cutover"] as const, "rehearsal", "--mode");
  const facts = env.readFacts(dbPath);

  let appId: number | undefined;
  let selection: number[] = [];
  if (scope === "application") {
    if (!values.app) {
      throw new ExportUsageError("--scope application needs --app <id|name>.");
    }
    appId = resolveApp(facts, values.app);
    selection = (values.with ?? []).flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean).map((entry) => resolveApp(facts, entry));
  } else if (values.app || values.with) {
    throw new ExportUsageError("--app and --with only apply to --scope application.");
  }

  const perApp: Record<string, SnapshotStrategy> = {};
  for (const [name, strategy] of pairs(values["app-strategy"], "--app-strategy")) {
    if (!["stop", "freeze", "live", "hook"].includes(strategy)) {
      throw new ExportUsageError(`--app-strategy ${name}=${strategy}: the strategy must be stop, freeze, live or hook.`);
    }
    perApp[name] = strategy as SnapshotStrategy;
  }
  const acceptRisks: Record<string, ConsistencyLevel> = {};
  for (const [name, level] of pairs(values["accept-risk"], "--accept-risk")) {
    if (!(CONSISTENCY_LEVELS as readonly string[]).includes(level) || level === "not-applicable" || level === "application-consistent") {
      throw new ExportUsageError(`--accept-risk ${name}=${level}: the level must be one of quiesced-unverified, crash-consistent, inconsistent.`);
    }
    acceptRisks[name] = level as ConsistencyLevel;
  }

  const options: ExportOptions = {
    ...DEFAULT_OPTIONS,
    scope,
    operation,
    mode,
    appId,
    selection,
    strategies: { default: oneOf(values.strategy, STRATEGIES, "auto", "--strategy") as StrategyChoice, perApp },
    hooks: values["hooks-file"] ? parseHooksFile(env.readText(values["hooks-file"])) : {},
    acceptRisks,
    quiesce: oneOf(values.quiesce, ["group", "sequential"] as const, "group", "--quiesce"),
    allowUnexported: values["allow-unexported"] === true,
    includeRegistryImages: values["include-registry-images"] === true
  };

  const helperImage = values["helper-image"] ?? ex.helperImage;
  if (!helperImage) {
    throw new ExportUsageError("No helper image is known. Run this through `deployment-platform migrate export`, or pass --helper-image <a local image>.");
  }

  const client = ex.createClient();
  const probe = env.createProbe();
  const outputFree = env.freeSpace(values["output-dir"])?.free ?? null;

  // Gather the read-only facts the plan needs.
  const containers = new Map<number, ExportContainerInfo | null>();
  for (const app of facts.apps) {
    containers.set(app.id, await client.inspectContainer(app.containerName));
  }
  let usage = { volumeSizes: new Map<string, number | null>(), imageSizes: new Map<string, number>() };
  try {
    usage = await probe.diskUsage();
  } catch {
    // sizes unknown: the plan says so and the free-space watcher covers the rest.
  }
  const localImageTags = new Set((await probe.listImages()).flatMap((image) => image.tags));

  // The Phase 0 read-only preflight is the first gate: a blocked installation is never exported.
  const preflight = await runSourcePreflight({
    scope,
    operation,
    appId,
    selection,
    facts,
    docker: probe,
    encryption: env.loadEncryption(),
    platformVersion: env.platformVersion,
    maxKnownSchemaVersion: env.maxSchemaVersion,
    outputFreeBytes: outputFree,
    outputFreeSource: "output directory",
    now: env.now()
  });
  if (preflight.verdict === "blocked") {
    return { exitCode: EXIT_BLOCKED, stdout: `${renderReportText(preflight)}\n`, stderr: "The export was NOT started: the preflight is blocked. Nothing was changed.\n" };
  }

  const plan = planExport({
    facts,
    containers,
    usage,
    localImageTags,
    options,
    dbSizeBytes: ex.dbSize(dbPath),
    hostPaths: { config: ex.configDir !== null && env.fileExists(ex.configDir), routes: ex.routesDir !== null && env.fileExists(ex.routesDir) },
    outputFreeBytes: outputFree
  });

  if (plan.refusals.length > 0) {
    const lines = ["The export was REFUSED before anything was touched:", ""];
    for (const refusal of plan.refusals) {
      lines.push(`  ✗ ${refusal.message}`, `      → ${refusal.remedy}`);
    }

    return { exitCode: EXIT_BLOCKED, stdout: `${lines.join("\n")}\n\nNo application was stopped, paused or changed, and no bundle was created.\n`, stderr: "" };
  }

  const info = await probe.info();
  const passphrase = env.readPassphrase(values["passphrase-file"]);
  const signingKeyPem = values["signing-key-file"] ? ex.readSigningKey(values["signing-key-file"]) : undefined;
  const run = defaultRunOptions({
    verify: oneOf(values.verify, ["none", "structure", "deep"] as const, "deep", "--verify"),
    gzipLevel: integer(values["gzip-level"], 3, 1, 9, "--gzip-level"),
    graceSeconds: integer(values["grace-seconds"], 30, 1, 600, "--grace-seconds"),
    maxDisruptionMs: integer(values["max-disruption-minutes"], 30, 1, 24 * 60, "--max-disruption-minutes") * 60_000,
    bundleName: values["bundle-name"],
    signal: ex.signal,
    log: ex.log,
    now: env.now,
    freeSpace: (path) => env.freeSpace(path)?.free ?? null
  });

  try {
    const result = await runExport({
      plan,
      facts,
      dbPath,
      outputDir: values["output-dir"],
      passphrase,
      signingKeyPem,
      client,
      encryption: env.loadEncryption(),
      hostPaths: { configDir: ex.configDir, routesDir: ex.routesDir },
      stateDir: ex.stateDir,
      helperImage,
      server: {
        serverId: deriveServerId(info.daemonId, info.hostname),
        platformVersion: env.platformVersion,
        schemaVersion: facts.schemaVersion,
        arch: info.arch,
        dockerVersion: info.dockerVersion
      },
      options: run
    });
    const report = buildExportReport(result, env.now());
    const text = values.format === "json" ? JSON.stringify(report, null, 2) : renderReportText(report);

    return { exitCode: report.verdict === "ready" ? EXIT_READY : report.verdict === "blocked" ? EXIT_BLOCKED : EXIT_WARNINGS, stdout: `${text}\n`, stderr: "" };
  } catch (error) {
    if (error instanceof ExportRefusedError) {
      return { exitCode: EXIT_BLOCKED, stdout: "", stderr: `${error.message}\nNothing was changed.\n` };
    }
    if (error instanceof ExportBusyError) {
      return { exitCode: EXIT_EXPORT_FAILED, stdout: "", stderr: `${error.message}\n` };
    }
    if (error instanceof ExportFailedError) {
      if (error.restoreFailed) {
        const down = error.restore.failed.map((f) => `  ✗ ${f.containerName}: ${f.error}`).join("\n");

        return {
          exitCode: EXIT_RESTORE_FAILED,
          stdout: "",
          stderr:
            `EXPORT FAILED: ${error.message}\n\n!! THESE APPLICATIONS COULD NOT BE RESTORED AND MAY BE DOWN !!\n${down}\n\n` +
            "Fix the cause, then run: deployment-platform migrate recover\n(the recovery journal has been kept).\n"
        };
      }

      return {
        exitCode: EXIT_EXPORT_FAILED,
        stdout: "",
        stderr:
          `EXPORT FAILED: ${error.message}\n` +
          `All applications that were stopped or paused have been restored${error.restore.restored.length > 0 ? ` (${error.restore.restored.join(", ")})` : ""}. ` +
          `${error.bundleRemoved ? "The partial bundle was removed." : "No bundle was created."}\n`
      };
    }

    throw error;
  }
}

// ------------------------------------------------------------------ recover ----

export async function runRecoverCommand(values: ExportValues, ex: ExportEnvironment): Promise<CliResult> {
  const results = await recoverDisruptions(ex.createClient(), ex.stateDir, { force: values.force === true, log: ex.log });

  if (results.length === 0) {
    return emitText(EXIT_READY, "Nothing to recover: no interrupted export was found.");
  }

  const lines: string[] = [];
  let failed = false;
  for (const result of results) {
    if (result.skippedActive) {
      lines.push(`Export ${result.exportId}: still running (recent heartbeat); left alone. Use --force only if you are sure it is dead.`);
      continue;
    }
    for (const name of result.restored) {
      lines.push(`  ✓ restarted ${name}`);
    }
    for (const problem of result.failed) {
      failed = true;
      lines.push(`  ✗ COULD NOT restore ${problem.containerName}: ${problem.error}`);
    }
    if (result.partialBundleRemoved) {
      lines.push("  ✓ removed the unfinished bundle the interrupted export left behind");
    }
    if (result.helpersRemoved > 0) {
      lines.push(`  ✓ removed ${result.helpersRemoved} leftover helper container(s)`);
    }
  }
  lines.push(failed ? "\nSome applications could NOT be restored. Fix the cause and run this again." : "\nRecovery complete.");

  return emitText(failed ? EXIT_RESTORE_FAILED : EXIT_READY, lines.join("\n"));
}

// -------------------------------------------------------------- signing key ----

export function runSigningKeyCommand(subcommand: string | undefined, values: ExportValues & { "key-file"?: string }, ex: ExportEnvironment): CliResult {
  if (subcommand === "generate") {
    if (!values["output-dir"]) {
      throw new ExportUsageError("signing-key generate needs --output-dir (an empty, writable directory).");
    }
    const { publicKeyDer, privateKeyPem } = generateSigningKeyPair();
    const keyPath = `${values["output-dir"].replace(/[\\/]+$/, "")}/migration-signing-key.pem`;
    try {
      ex.writeNewFile(keyPath, privateKeyPem, 0o600);
    } catch (error) {
      throw new ExportUsageError(`Could not create ${keyPath}: ${(error as Error).message}. (An existing key is never overwritten.)`);
    }
    const fingerprint = fingerprintOf(publicKeyDer);

    return emitText(
      EXIT_READY,
      `Created ${keyPath} (mode 600). KEEP IT PRIVATE.\n\nSigner fingerprint:\n  ${fingerprint}\n\n` +
        "Give the fingerprint to whoever will import bundles, by a channel other than the bundle itself, and have them verify with --expect-signer.\n" +
        "Sign an export with --signing-key-file."
    );
  }

  if (subcommand === "fingerprint") {
    if (!values["key-file"]) {
      throw new ExportUsageError("signing-key fingerprint needs --key-file.");
    }
    const pem = ex.readSigningKey(values["key-file"]);

    return emitText(EXIT_READY, fingerprintOf(createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }) as Buffer));
  }

  throw new ExportUsageError("signing-key needs a subcommand: generate or fingerprint.");
}

export { formatBytes };
