import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type Docker from "dockerode";
import type { AppDatabase, StoredApp } from "../database.js";

const SAFE_SUBDOMAIN_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface RoutingStatus {
  enabled: boolean;
  lastReconciledAt: string | null;
  lastReconcileSucceeded: boolean | null;
  lastError: string | null;
  routedAppCount: number;
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
}

/**
 * Builds the apps.caddy content from stored apps only — every value used
 * here (domain, container name, port) is derived from the app name and
 * integer port already validated at creation time, never from free-form
 * request input, so no arbitrary Caddy directive can be injected.
 */
export function generateCaddyConfig(apps: StoredApp[]): string {
  const routedApps = apps.filter(
    (app) =>
      app.domain &&
      app.containerName &&
      SAFE_SUBDOMAIN_LABEL.test(app.name) &&
      Number.isInteger(app.containerPort) &&
      app.containerPort > 0 &&
      app.containerPort <= 65535
  );

  const blocks = routedApps.map((app) =>
    [
      `${app.domain} {`,
      `\tencode zstd gzip`,
      `\treverse_proxy ${app.containerName}:${app.containerPort}`,
      `}`
    ].join("\n")
  );

  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
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

export function createRoutingService(options: RoutingServiceOptions) {
  let status: RoutingStatus = {
    enabled: options.enabled,
    lastReconciledAt: null,
    lastReconcileSucceeded: null,
    lastError: options.enabled
      ? null
      : "Dynamic routing is disabled (ROUTING_ENABLED is not set to true)",
    routedAppCount: 0
  };

  function getStatus(): RoutingStatus {
    return { ...status };
  }

  async function reconcile(appDatabase: AppDatabase): Promise<RoutingStatus> {
    if (!options.enabled) {
      status = {
        ...status,
        enabled: false,
        lastReconciledAt: new Date().toISOString(),
        lastReconcileSucceeded: false,
        lastError:
          "Dynamic routing is disabled (ROUTING_ENABLED is not set to true)",
        routedAppCount: 0
      };

      return getStatus();
    }

    const apps = appDatabase.listApps();
    const config = generateCaddyConfig(apps);

    const targetPathInApi = join(options.routesDirInApi, options.appsFilename);
    const tempFilename = `${options.appsFilename}.tmp-${randomBytes(6).toString("hex")}`;
    const tempPathInApi = join(options.routesDirInApi, tempFilename);
    const tempPathInCaddy = join(options.routesDirInCaddy, tempFilename);

    try {
      writeFileSync(tempPathInApi, config, { mode: 0o644 });

      const validateResult = await execInContainer(
        options.docker,
        options.caddyContainerName,
        ["caddy", "validate", "--config", tempPathInCaddy, "--adapter", "caddyfile"]
      );

      if (validateResult.exitCode !== 0) {
        throw new Error(
          `Generated routing configuration failed validation: ${validateResult.output.trim()}`
        );
      }

      // Only replace the active file once the candidate has been validated.
      renameSync(tempPathInApi, targetPathInApi);

      const reloadResult = await execInContainer(
        options.docker,
        options.caddyContainerName,
        ["caddy", "reload", "--config", options.mainCaddyfilePathInCaddy]
      );

      if (reloadResult.exitCode !== 0) {
        throw new Error(`Caddy reload failed: ${reloadResult.output.trim()}`);
      }

      status = {
        enabled: true,
        lastReconciledAt: new Date().toISOString(),
        lastReconcileSucceeded: true,
        lastError: null,
        routedAppCount: apps.filter((app) => app.domain).length
      };
    } catch (error) {
      if (existsSync(tempPathInApi)) {
        rmSync(tempPathInApi, { force: true });
      }

      status = {
        ...status,
        enabled: true,
        lastReconciledAt: new Date().toISOString(),
        lastReconcileSucceeded: false,
        lastError:
          error instanceof Error ? error.message : "Unknown routing error"
      };
    }

    return getStatus();
  }

  return {
    getStatus,
    reconcile
  };
}

export type RoutingService = ReturnType<typeof createRoutingService>;
