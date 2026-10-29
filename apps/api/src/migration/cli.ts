import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Docker from "dockerode";
import { ZodError } from "zod";
import { listMigrations } from "../migrations/index.js";
import { loadEncryptionKey, type EncryptionKeyStatus } from "../services/crypto-service.js";
import { EXIT_BLOCKED, EXIT_INTERNAL, EXIT_READY, EXIT_USAGE, EXIT_WARNINGS } from "./constants.js";
import { MigrationCryptoError } from "./crypto.js";
import { parseDescriptor, type DestinationDescriptor } from "./destination.js";
import type { PlatformFacts } from "./facts.js";
import { readPlatformFacts } from "./inventory.js";
import { runExportCommand, runRecoverCommand, runSigningKeyCommand, ExportUsageError, type ExportEnvironment } from "./export-cli.js";
import { createExportDockerClient } from "./export-docker.js";
import { readPassphraseFile } from "./passphrase.js";
import {
  describeServer,
  runBundleVerification,
  runDestinationPreflight,
  runSourcePreflight
} from "./preflight.js";
import { createDockerProbe, readOnlyClientFrom, type ReadOnlyDockerProbe } from "./probes.js";
import { renderReportText, type Verdict, type VerificationReport } from "./report.js";

/**
 * Command-line entry point for the migration foundation (Phase 0).
 *
 *   describe        print this server's destination descriptor (JSON)
 *   preflight       read-only readiness report (source or destination role)
 *   verify-bundle   verify a bundle's integrity and authenticity
 *
 * Every command is read-only. All I/O goes through `CliEnvironment`, so the whole
 * CLI is testable with no Docker daemon and no real filesystem.
 */

export interface CliEnvironment {
  readText(path: string): string;
  readPassphrase(path: string): string;
  fileExists(path: string): boolean;
  readFacts(dbPath: string): PlatformFacts;
  createProbe(): ReadOnlyDockerProbe;
  loadEncryption(): EncryptionKeyStatus;
  freeSpace(path: string): { free: number; total: number } | null;
  platformVersion: string;
  defaultDbPath: string;
  maxSchemaVersion: number;
  now(): Date;
  /** Phase 1: what `export`, `recover` and `signing-key` need. Absent in read-only-only environments. */
  exporter?: ExportEnvironment;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const USAGE = `Usage: migrate <command> [options]

Commands
  describe                       Print this server's description (JSON) for a source to check against.
  preflight                      Read-only readiness report.
  verify-bundle                  Verify a bundle's integrity and authenticity.
  export                         Write an ENCRYPTED bundle (platform or one app). Read-only except a brief, always-restored quiesce.
  recover                        Restart anything an interrupted export left stopped or paused.
  signing-key generate|fingerprint   Create or show the key that signs bundles.

preflight options
  --role source|destination      Which side this server is (default: source)
  --scope platform|application   What is being migrated (default: platform)
  --app <id|name>                The application (application scope)
  --with <id|name>[,...]         Apps migrating together with --app (repeatable)
  --operation backup|copy|move   Intent (default: backup for platform, copy for application)
  --destination-descriptor FILE  Output of 'describe' on the destination, to check compatibility
  --output-dir DIR               Where the bundle would be written (checks free space)
  --output-free-bytes N          Free bytes at the output location, if DIR is not visible here
  --bundle DIR                   (destination) a bundle to verify and plan an import of
  --passphrase-file FILE         File holding the bundle passphrase (mode 600; never an argument)
  --expect-signer FINGERPRINT    Pin the source's signing key (proves origin)
  --require-signature            Fail if the bundle is unsigned
  --deep                         Authenticate every byte of every artifact
verify-bundle options
  --bundle DIR  --passphrase-file FILE  [--expect-signer FP]  [--require-signature]  [--deep]
common
  --format text|json             Output format (default: text)
  --db-path FILE                 Platform database (default: $DATABASE_PATH or /data/deployment-platform.sqlite)

export options
  --output-dir DIR  --passphrase-file FILE  [--scope platform|application --app NAME --with NAME,...]
  --mode rehearsal|cutover        (cutover demands evidence of consistency, or an explicit --accept-risk)
  --strategy auto|stop|freeze|live|hook   --app-strategy NAME=stop|freeze|live|hook
  --hooks-file FILE               operator dump hooks (each must say how its output is verified)
  --accept-risk NAME=quiesced-unverified|crash-consistent   --quiesce group|sequential
  --allow-unexported  --include-registry-images  --signing-key-file FILE  --verify none|structure|deep
  --bundle-name N  --grace-seconds N  --max-disruption-minutes N  --gzip-level 1-9  --helper-image IMAGE

Exit codes: 0 ready, 10 ready with warnings, 20 blocked/refused, 4 export failed (apps restored),
            5 export failed AND an app could not be restored, 2 usage error, 3 internal error.
Nothing here modifies any server, container, volume or database.
`;

class UsageError extends Error {}

/** The environment (not the arguments) is the problem: e.g. the Docker daemon is unreachable. */
class EnvironmentError extends Error {}

const EXIT_FOR_VERDICT: Record<Verdict, number> = {
  ready: EXIT_READY,
  "ready-with-warnings": EXIT_WARNINGS,
  blocked: EXIT_BLOCKED
};

const OPTIONS = {
  role: { type: "string" },
  scope: { type: "string" },
  app: { type: "string" },
  with: { type: "string", multiple: true },
  operation: { type: "string" },
  "destination-descriptor": { type: "string" },
  "output-dir": { type: "string" },
  "output-free-bytes": { type: "string" },
  bundle: { type: "string" },
  "passphrase-file": { type: "string" },
  "expect-signer": { type: "string" },
  "require-signature": { type: "boolean" },
  deep: { type: "boolean" },
  format: { type: "string" },
  "db-path": { type: "string" },
  // --- Phase 1: export ---
  mode: { type: "string" },
  strategy: { type: "string" },
  "app-strategy": { type: "string", multiple: true },
  "hooks-file": { type: "string" },
  "accept-risk": { type: "string", multiple: true },
  quiesce: { type: "string" },
  "allow-unexported": { type: "boolean" },
  "include-registry-images": { type: "boolean" },
  "signing-key-file": { type: "string" },
  "key-file": { type: "string" },
  verify: { type: "string" },
  "bundle-name": { type: "string" },
  "helper-image": { type: "string" },
  "grace-seconds": { type: "string" },
  "max-disruption-minutes": { type: "string" },
  "gzip-level": { type: "string" },
  force: { type: "boolean" },
  help: { type: "boolean", short: "h" }
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, flag: string): T {
  if (value === undefined) {
    return fallback;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}.`);
  }

  return value as T;
}

export function resolveApp(facts: PlatformFacts, reference: string): number {
  if (/^\d+$/.test(reference)) {
    const id = Number(reference);
    if (facts.apps.some((app) => app.id === id)) {
      return id;
    }
    throw new UsageError(`No application with id ${id}.`);
  }

  const matches = facts.apps.filter((app) => app.name === reference);
  if (matches.length === 0) {
    throw new UsageError(`No application named "${reference}".`);
  }
  if (matches.length > 1) {
    throw new UsageError(`More than one application is named "${reference}"; use its id.`);
  }

  return matches[0]!.id;
}

function emit(report: VerificationReport, format: "text" | "json"): CliResult {
  return {
    exitCode: EXIT_FOR_VERDICT[report.verdict],
    stdout: format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `${renderReportText(report)}\n`,
    stderr: ""
  };
}

function loadFacts(env: CliEnvironment, dbPath: string): { facts: PlatformFacts | null; error: string | null } {
  if (!env.fileExists(dbPath)) {
    return { facts: null, error: `No platform database was found at ${dbPath}.` };
  }

  try {
    return { facts: env.readFacts(dbPath), error: null };
  } catch (error) {
    return { facts: null, error: `The platform database could not be read: ${(error as Error).message}` };
  }
}

async function describeLocal(env: CliEnvironment, facts: PlatformFacts | null, dbPath: string): Promise<DestinationDescriptor> {
  try {
    return await describeServer({
      docker: env.createProbe(),
      facts,
      platformVersion: env.platformVersion,
      maxSchemaVersion: env.maxSchemaVersion,
      encryption: env.loadEncryption(),
      diskPath: dirname(dbPath),
      now: env.now()
    });
  } catch (error) {
    throw new EnvironmentError(`The Docker daemon could not be queried: ${(error as Error).message}`);
  }
}

export async function runCli(argv: string[], env: CliEnvironment): Promise<CliResult> {
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const values: Values = parsed.values;
    const command = parsed.positionals[0];

    if (values.help || command === undefined || command === "help") {
      return { exitCode: command === undefined && !values.help ? EXIT_USAGE : EXIT_READY, stdout: USAGE, stderr: "" };
    }
    if (parsed.positionals.length > (command === "signing-key" ? 2 : 1)) {
      throw new UsageError(`Unexpected argument "${parsed.positionals[1]}".`);
    }

    const format = oneOf(values.format, ["text", "json"] as const, "text", "--format");
    const dbPath = values["db-path"] ?? env.defaultDbPath;

    switch (command) {
      case "describe": {
        const { facts } = loadFacts(env, dbPath);
        const descriptor = await describeLocal(env, facts, dbPath);

        return { exitCode: EXIT_READY, stdout: `${JSON.stringify(descriptor, null, 2)}\n`, stderr: "" };
      }

      case "export":
      case "recover":
      case "signing-key": {
        if (!env.exporter) {
          throw new UsageError(`'${command}' is not available in this environment.`);
        }
        if (command === "export") {
          return await runExportCommand({ ...values, format: values.format }, env, env.exporter, resolveApp);
        }
        if (command === "recover") {
          return await runRecoverCommand(values, env.exporter);
        }

        return runSigningKeyCommand(parsed.positionals[1], values, env.exporter);
      }

      case "verify-bundle": {
        if (!values.bundle || !values["passphrase-file"]) {
          throw new UsageError("verify-bundle needs --bundle and --passphrase-file.");
        }

        return emit(
          await runBundleVerification({
            directory: values.bundle,
            passphrase: env.readPassphrase(values["passphrase-file"]),
            options: {
              deep: values.deep === true,
              expectedSignerFingerprint: values["expect-signer"],
              requireSignature: values["require-signature"] === true
            },
            now: env.now()
          }),
          format
        );
      }

      case "preflight": {
        const role = oneOf(values.role, ["source", "destination"] as const, "source", "--role");
        const scope = oneOf(values.scope, ["platform", "application"] as const, "platform", "--scope");

        if (role === "destination") {
          const { facts } = loadFacts(env, dbPath);
          const descriptor = await describeLocal(env, facts, dbPath);

          if (values.bundle && !values["passphrase-file"]) {
            throw new UsageError("--bundle needs --passphrase-file (a passphrase is never accepted as an argument).");
          }

          return emit(
            await runDestinationPreflight({
              descriptor,
              bundle: values.bundle
                ? {
                    directory: values.bundle,
                    passphrase: env.readPassphrase(values["passphrase-file"]!),
                    deep: values.deep === true,
                    expectedSignerFingerprint: values["expect-signer"],
                    requireSignature: values["require-signature"] === true
                  }
                : undefined,
              now: env.now()
            }),
            format
          );
        }

        // role: source
        const operation = oneOf(
          values.operation,
          ["backup", "copy", "move"] as const,
          scope === "application" ? "copy" : "backup",
          "--operation"
        );
        const { facts, error } = loadFacts(env, dbPath);

        let appId: number | undefined;
        let selection: number[] | undefined;
        if (scope === "application") {
          if (!values.app) {
            throw new UsageError("--scope application needs --app <id|name>.");
          }
          if (facts) {
            appId = resolveApp(facts, values.app);
            selection = (values.with ?? [])
              .flatMap((entry) => entry.split(","))
              .map((entry) => entry.trim())
              .filter(Boolean)
              .map((entry) => resolveApp(facts, entry));
          }
        } else if (values.app || values.with) {
          throw new UsageError("--app and --with only apply to --scope application.");
        }

        let outputFreeBytes: number | null = null;
        let outputFreeSource: string | undefined;
        if (values["output-free-bytes"] !== undefined) {
          const parsedBytes = Number(values["output-free-bytes"]);
          if (!Number.isFinite(parsedBytes) || parsedBytes < 0) {
            throw new UsageError("--output-free-bytes must be a non-negative number.");
          }
          outputFreeBytes = parsedBytes;
          outputFreeSource = "as given";
        } else if (values["output-dir"]) {
          outputFreeBytes = env.freeSpace(values["output-dir"])?.free ?? null;
          outputFreeSource = "output directory";
        } else {
          outputFreeBytes = env.freeSpace(dirname(dbPath))?.free ?? null;
          outputFreeSource = "the platform data volume — approximate; pass --output-dir for the real target";
        }

        let destination: DestinationDescriptor | null = null;
        if (values["destination-descriptor"]) {
          try {
            destination = parseDescriptor(JSON.parse(env.readText(values["destination-descriptor"])));
          } catch (descriptorError) {
            throw new UsageError(
              `The destination descriptor is not valid (${
                descriptorError instanceof ZodError ? "unexpected structure" : (descriptorError as Error).message
              }). Produce it with 'migrate describe' on the destination.`
            );
          }
        }

        return emit(
          await runSourcePreflight({
            scope,
            operation,
            appId,
            selection,
            facts,
            factsError: error,
            docker: env.createProbe(),
            encryption: env.loadEncryption(),
            platformVersion: env.platformVersion,
            maxKnownSchemaVersion: env.maxSchemaVersion,
            outputFreeBytes,
            outputFreeSource,
            destination,
            diskPath: dirname(dbPath),
            now: env.now()
          }),
          format
        );
      }

      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ExportUsageError) {
      return { exitCode: EXIT_USAGE, stdout: "", stderr: `${error.message}\n\n${USAGE}` };
    }
    // Unknown option, missing value, etc. from the argument parser.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      return { exitCode: EXIT_USAGE, stdout: "", stderr: `${error.message}\n\n${USAGE}` };
    }
    if (error instanceof EnvironmentError) {
      return { exitCode: EXIT_INTERNAL, stdout: "", stderr: `${error.message}\n` };
    }
    if (error instanceof MigrationCryptoError) {
      return { exitCode: EXIT_USAGE, stdout: "", stderr: `${error.message}\n` };
    }

    // Never print a stack trace: it could echo user-supplied paths or values.
    return { exitCode: EXIT_INTERNAL, stdout: "", stderr: `Internal error: ${(error as Error).message}\n` };
  }
}

export function realEnvironment(): CliEnvironment {
  const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });

  return {
    readText: (path) => readFileSync(path, "utf8"),
    readPassphrase: readPassphraseFile,
    fileExists: existsSync,
    readFacts: readPlatformFacts,
    createProbe: () => createDockerProbe(readOnlyClientFrom(docker)),
    loadEncryption: loadEncryptionKey,
    freeSpace: (path) => {
      try {
        const stats = statfsSync(path);

        return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
      } catch {
        return null;
      }
    },
    platformVersion: process.env.APP_VERSION ?? "dev",
    defaultDbPath: process.env.DATABASE_PATH ?? "/data/deployment-platform.sqlite",
    maxSchemaVersion: Math.max(0, ...listMigrations().map((migration) => migration.version)),
    now: () => new Date(),
    exporter: realExporterEnvironment(docker)
  };
}

function realExporterEnvironment(docker: Docker): ExportEnvironment {
  // Ctrl-C / SIGTERM must never just kill the process mid-snapshot: they abort the export, which then
  // restores every app. A second signal means "now": exit at once (the journal still allows recovery).
  const controller = new AbortController();
  let signals = 0;
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.on(name, () => {
      signals += 1;
      if (signals > 1) {
        process.exit(130);
      }
      process.stderr.write(`\nReceived ${name}: stopping the export and restoring applications (signal again to force quit)…\n`);
      controller.abort(new Error(`cancelled by ${name}`));
    });
  }

  const exists = (path: string): string | null => (existsSync(path) ? path : null);

  return {
    createClient: () => createExportDockerClient(docker),
    configDir: exists(process.env.DP_MIGRATE_CONFIG_DIR ?? "/migration/host/config"),
    routesDir: exists(process.env.DP_MIGRATE_ROUTES_DIR ?? "/migration/host/caddy-routes"),
    stateDir: process.env.DP_MIGRATE_STATE_DIR ?? "/migration/state",
    helperImage: process.env.DP_MIGRATE_HELPER_IMAGE ?? null,
    signal: controller.signal,
    log: (message) => void process.stderr.write(`${message}\n`),
    writeNewFile: (path, content, mode) => writeFileSync(path, content, { flag: "wx", mode }),
    readSigningKey: (path) => {
      const pem = readFileSync(path, "utf8");
      createPrivateKey(pem); // throws if it is not a usable private key
      return pem;
    },
    dbSize: (path) => {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    }
  };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const result = await runCli(process.argv.slice(2), realEnvironment());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
