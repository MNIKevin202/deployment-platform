import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type Docker from "dockerode";
import type { AppDatabase, StoredApp } from "../database.js";

/**
 * A DNS subdomain label used as an app name. Kept for backward compatibility;
 * domain/upstream values are validated far more strictly below.
 */
const SAFE_SUBDOMAIN_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A full hostname: one or more DNS labels joined by dots, lowercase, total
 * length <= 253, each label 1–63 chars, no leading/trailing hyphen. Crucially
 * this excludes whitespace, `{`, `}`, `#`, and every other character a Caddy
 * directive could hide behind — so a domain value can never break out of its
 * site-address position and inject a directive.
 */
const SAFE_DOMAIN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A Docker container name (the reverse-proxy upstream host). Docker allows
 * `[a-zA-Z0-9][a-zA-Z0-9_.-]+`; anything outside that cannot be a real upstream
 * and is rejected rather than written.
 */
const SAFE_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export interface RoutingStatus {
  /** The feature flag — whether dynamic routing is turned on at all. */
  enabled: boolean;
  /**
   * Whether routing is actually LIVE: enabled AND the last reconciliation
   * generated, validated, applied, and verified a config successfully. The
   * dashboard must use this, not `enabled`, before claiming "Routing Enabled".
   */
  active: boolean;
  lastReconciledAt: string | null;
  lastReconcileSucceeded: boolean | null;
  lastError: string | null;
  routedAppCount: number;
  /** How many candidate routes were rejected (invalid/duplicate) last run. */
  rejectedRouteCount: number;
}

/**
 * The Caddy operations the reconciler depends on. Injecting these keeps the
 * whole validate → apply → verify pipeline testable without a real Docker
 * daemon, and keeps the "how do we talk to Caddy" concern in one place.
 */
export interface CaddyOperations {
  /** `caddy validate` on a single candidate route file (syntax gate). */
  validateConfigFile(pathInCaddy: string): Promise<{ ok: boolean; output: string }>;
  /** `caddy validate` on the whole main Caddyfile (the merged result). */
  validateMainConfig(): Promise<{ ok: boolean; output: string }>;
  /**
   * Apply the on-disk configuration to the running Caddy WITHOUT requiring the
   * admin API: a reload is attempted first (a no-op win if admin is ever
   * enabled) and a container restart is the reliable fallback. TLS material
   * lives in the caddy-data volume, so a restart does not re-issue certs.
   */
  apply(): Promise<{ ok: boolean; output: string }>;
  /** Confirm Caddy is up and serving after an apply (health verification). */
  verify(): Promise<{ ok: boolean; output: string }>;
}

export interface RoutingServiceOptions {
  enabled: boolean;
  docker: Docker;
  /** Directory holding the generated apps.caddy file, as seen from THIS (API) container. */
  routesDirInApi: string;
  /** The same host directory, as seen from inside the Caddy container. */
  routesDirInCaddy: string;
  caddyContainerName: string;
  /** Path to the main Caddyfile, as seen from inside the Caddy container. */
  mainCaddyfilePathInCaddy: string;
  appsFilename: string;
  /** Test seam: override the Docker-backed Caddy operations. */
  operations?: CaddyOperations;
}

export interface RouteEntry {
  appId: number;
  domain: string;
  upstream: string;
}

export interface RejectedRoute {
  appId: number;
  reason: string;
}

export interface BuiltRoutes {
  config: string;
  routes: RouteEntry[];
  rejected: RejectedRoute[];
}

/**
 * Turns the stored apps into a validated set of routes plus the Caddy config
 * text. Every value is validated before it is allowed into the config, so:
 *
 *  - a malformed or unsafe domain/upstream is REJECTED (never written), and
 *  - a domain claimed by more than one app is rejected for ALL claimants, so
 *    one app's route can never silently overwrite another's.
 *
 * Output is deterministically ordered by domain, so reconciling the same state
 * twice produces byte-identical config (idempotency).
 */
export function buildRoutes(apps: StoredApp[]): BuiltRoutes {
  const rejected: RejectedRoute[] = [];
  const candidates: RouteEntry[] = [];

  for (const app of apps) {
    // Apps without a domain are simply not routed — not an error.
    if (!app.domain) continue;

    if (!SAFE_SUBDOMAIN_LABEL.test(app.name)) {
      rejected.push({ appId: app.id, reason: "unsafe app name" });
      continue;
    }
    if (typeof app.domain !== "string" || !SAFE_DOMAIN.test(app.domain)) {
      rejected.push({ appId: app.id, reason: "invalid domain" });
      continue;
    }
    if (!app.containerName || !SAFE_CONTAINER_NAME.test(app.containerName)) {
      rejected.push({ appId: app.id, reason: "invalid upstream container" });
      continue;
    }
    if (
      !Number.isInteger(app.containerPort) ||
      app.containerPort <= 0 ||
      app.containerPort > 65535
    ) {
      rejected.push({ appId: app.id, reason: "invalid upstream port" });
      continue;
    }

    candidates.push({
      appId: app.id,
      domain: app.domain,
      upstream: `${app.containerName}:${app.containerPort}`
    });
  }

  // Reject every app that shares a domain with another — neither may win.
  const byDomain = new Map<string, RouteEntry[]>();
  for (const route of candidates) {
    const list = byDomain.get(route.domain) ?? [];
    list.push(route);
    byDomain.set(route.domain, list);
  }

  const routes: RouteEntry[] = [];
  for (const [domain, list] of byDomain) {
    if (list.length > 1) {
      for (const route of list) {
        rejected.push({ appId: route.appId, reason: `duplicate domain ${domain}` });
      }
      continue;
    }
    routes.push(list[0]!);
  }

  routes.sort((a, b) => a.domain.localeCompare(b.domain));

  const blocks = routes.map((route) =>
    [
      `${route.domain} {`,
      `\tencode zstd gzip`,
      `\treverse_proxy ${route.upstream}`,
      `}`
    ].join("\n")
  );

  return {
    config: blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "",
    routes,
    rejected
  };
}

/**
 * Backward-compatible helper: the Caddy config text for the given apps.
 * Per-app routes come only from validated stored fields, so no arbitrary Caddy
 * directive can be injected from request input.
 */
export function generateCaddyConfig(apps: StoredApp[]): string {
  return buildRoutes(apps).config;
}

interface ExecResult {
  exitCode: number;
  output: string;
}

async function execInContainer(
  docker: Docker,
  containerName: string,
  cmd: string[]
): Promise<ExecResult> {
  const container = docker.getContainer(containerName);

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true
  });

  const stream = await exec.start({ hijack: true, stdin: false, Tty: true });

  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });

  const inspectResult = await exec.inspect();

  return {
    exitCode: inspectResult.ExitCode ?? 1,
    output: Buffer.concat(chunks).toString("utf8")
  };
}

/**
 * The default, Docker-backed Caddy operations. Apply mirrors the platform's
 * established mechanism (release-remote.sh / installer/lib/caddy.sh): try an
 * in-place reload, then fall back to a container restart, which is what makes
 * routing work with `admin off`.
 */
export function createDockerCaddyOperations(options: {
  docker: Docker;
  caddyContainerName: string;
  mainCaddyfilePathInCaddy: string;
}): CaddyOperations {
  const { docker, caddyContainerName, mainCaddyfilePathInCaddy } = options;

  async function isRunning(): Promise<boolean> {
    try {
      const info = await docker.getContainer(caddyContainerName).inspect();
      return info.State?.Running === true;
    } catch {
      return false;
    }
  }

  return {
    async validateConfigFile(pathInCaddy) {
      const result = await execInContainer(docker, caddyContainerName, [
        "caddy",
        "validate",
        "--adapter",
        "caddyfile",
        "--config",
        pathInCaddy
      ]);
      return { ok: result.exitCode === 0, output: result.output };
    },

    async validateMainConfig() {
      const result = await execInContainer(docker, caddyContainerName, [
        "caddy",
        "validate",
        "--config",
        mainCaddyfilePathInCaddy
      ]);
      return { ok: result.exitCode === 0, output: result.output };
    },

    async apply() {
      // Reload speaks to the admin API; with `admin off` it always fails, so a
      // restart is the reliable path. Reload is still tried first so this
      // becomes zero-downtime for free if the admin endpoint is ever enabled.
      try {
        const reload = await execInContainer(docker, caddyContainerName, [
          "caddy",
          "reload",
          "--config",
          mainCaddyfilePathInCaddy
        ]);
        if (reload.exitCode === 0) {
          return { ok: true, output: "reloaded in place" };
        }
      } catch {
        // fall through to restart
      }

      try {
        await docker.getContainer(caddyContainerName).restart({ t: 5 });
      } catch (error) {
        return {
          ok: false,
          output: error instanceof Error ? error.message : "restart failed"
        };
      }
      return { ok: true, output: "restarted" };
    },

    async verify() {
      // A config error surfaces as a container that exits right after restart,
      // so a running container is the health signal we can get with admin off.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (await isRunning()) return { ok: true, output: "running" };
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { ok: false, output: "Caddy is not running after apply" };
    }
  };
}

/** First non-empty line, control chars stripped, capped — safe to surface. */
function sanitizeDiagnostic(raw: string): string {
  const firstLine =
    raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const cleaned = Array.from(firstLine)
    .map((char) => (char.charCodeAt(0) < 0x20 ? " " : char))
    .join("");
  return cleaned.slice(0, 300);
}

export function createRoutingService(options: RoutingServiceOptions) {
  const operations =
    options.operations ??
    createDockerCaddyOperations({
      docker: options.docker,
      caddyContainerName: options.caddyContainerName,
      mainCaddyfilePathInCaddy: options.mainCaddyfilePathInCaddy
    });

  let status: RoutingStatus = {
    enabled: options.enabled,
    active: false,
    lastReconciledAt: null,
    lastReconcileSucceeded: null,
    lastError: options.enabled
      ? null
      : "Dynamic routing is disabled (ROUTING_ENABLED is not set to true)",
    routedAppCount: 0,
    rejectedRouteCount: 0
  };

  // Serializes reconciliation: a route change cannot start until the previous
  // one has fully finished, so concurrent creates/deletes can never interleave
  // their file writes and corrupt apps.caddy.
  let queue: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  const targetPathInApi = join(options.routesDirInApi, options.appsFilename);
  const targetPathInCaddy = join(options.routesDirInCaddy, options.appsFilename);
  const backupPathInApi = `${targetPathInApi}.bak`;

  function getStatus(): RoutingStatus {
    return { ...status };
  }

  function readCurrent(): string | null {
    return existsSync(targetPathInApi)
      ? readFileSync(targetPathInApi, "utf8")
      : null;
  }

  /** Atomic write: write to a unique temp, then rename over the destination. */
  function atomicWrite(destInApi: string, content: string): void {
    const tempName = `.${options.appsFilename}.tmp-${randomBytes(6).toString("hex")}`;
    const tempPath = join(options.routesDirInApi, tempName);
    writeFileSync(tempPath, content, { mode: 0o644 });
    renameSync(tempPath, destInApi);
  }

  /** Put the previous known-good file back (or remove it if there was none). */
  function restorePrevious(previous: string | null): void {
    if (previous === null) {
      if (existsSync(targetPathInApi)) rmSync(targetPathInApi, { force: true });
    } else {
      atomicWrite(targetPathInApi, previous);
    }
  }

  async function reconcileInner(appDatabase: AppDatabase): Promise<RoutingStatus> {
    if (!options.enabled) {
      status = {
        ...status,
        enabled: false,
        active: false,
        lastReconciledAt: new Date().toISOString(),
        lastReconcileSucceeded: false,
        lastError:
          "Dynamic routing is disabled (ROUTING_ENABLED is not set to true)",
        routedAppCount: 0,
        rejectedRouteCount: 0
      };
      return getStatus();
    }

    const now = () => new Date().toISOString();
    const apps = appDatabase.listApps();
    const built = buildRoutes(apps);
    const rejectionNote =
      built.rejected.length > 0
        ? `${built.rejected.length} route(s) rejected: ${built.rejected
            .map((r) => `app ${r.appId} (${r.reason})`)
            .join(", ")}`
        : null;

    const previous = readCurrent();

    // Idempotency: identical desired config and a healthy last run means there
    // is nothing to apply — never restart Caddy for a no-op.
    if (previous === built.config && status.lastReconcileSucceeded === true) {
      status = {
        ...status,
        enabled: true,
        active: true,
        lastReconciledAt: now(),
        lastReconcileSucceeded: true,
        lastError: rejectionNote,
        routedAppCount: built.routes.length,
        rejectedRouteCount: built.rejected.length
      };
      return getStatus();
    }

    try {
      // 1. Write the candidate to a temp file and validate it in isolation,
      //    BEFORE touching the active file (never restart before validating).
      if (built.config.trim().length > 0) {
        const candidateName = `.${options.appsFilename}.candidate-${randomBytes(6).toString("hex")}`;
        const candidatePathInApi = join(options.routesDirInApi, candidateName);
        const candidatePathInCaddy = join(options.routesDirInCaddy, candidateName);
        writeFileSync(candidatePathInApi, built.config, { mode: 0o644 });
        try {
          const candidateValidation =
            await operations.validateConfigFile(candidatePathInCaddy);
          if (!candidateValidation.ok) {
            throw new Error(
              `Candidate routing configuration failed validation: ${sanitizeDiagnostic(candidateValidation.output)}`
            );
          }
        } finally {
          if (existsSync(candidatePathInApi)) {
            rmSync(candidatePathInApi, { force: true });
          }
        }
      }

      // 2. Preserve the previous known-good file, then apply the candidate to
      //    disk atomically.
      if (previous !== null) atomicWrite(backupPathInApi, previous);
      atomicWrite(targetPathInApi, built.config);

      // 3. Validate the whole merged Caddyfile (this is what Caddy will load).
      const mainValidation = await operations.validateMainConfig();
      if (!mainValidation.ok) {
        restorePrevious(previous);
        throw new Error(
          `Merged Caddy configuration failed validation: ${sanitizeDiagnostic(mainValidation.output)}`
        );
      }

      // 4. Apply (reload → restart), then verify Caddy is actually serving. Any
      //    failure restores the previous config and re-applies it, so a bad
      //    candidate never leaves Caddy down or serving a broken config.
      const applied = await operations.apply();
      if (!applied.ok) {
        restorePrevious(previous);
        await operations.apply();
        throw new Error(
          `Failed to apply Caddy configuration: ${sanitizeDiagnostic(applied.output)}`
        );
      }

      const verified = await operations.verify();
      if (!verified.ok) {
        restorePrevious(previous);
        await operations.apply();
        throw new Error(
          `Caddy did not become healthy after applying routes: ${sanitizeDiagnostic(verified.output)}`
        );
      }

      status = {
        enabled: true,
        active: true,
        lastReconciledAt: now(),
        lastReconcileSucceeded: true,
        lastError: rejectionNote,
        routedAppCount: built.routes.length,
        rejectedRouteCount: built.rejected.length
      };
    } catch (error) {
      status = {
        ...status,
        enabled: true,
        active: false,
        lastReconciledAt: now(),
        lastReconcileSucceeded: false,
        lastError:
          error instanceof Error ? error.message : "Unknown routing error",
        rejectedRouteCount: built.rejected.length
      };
    }

    return getStatus();
  }

  async function reconcile(appDatabase: AppDatabase): Promise<RoutingStatus> {
    return runExclusive(() => reconcileInner(appDatabase));
  }

  return {
    getStatus,
    reconcile,
    // Exposed for verification/telemetry; never mutated externally.
    _paths: { targetPathInApi, targetPathInCaddy, backupPathInApi }
  };
}

export type RoutingService = ReturnType<typeof createRoutingService>;
