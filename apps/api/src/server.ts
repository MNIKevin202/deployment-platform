import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { docker } from "./docker.js";
import { registerAuthentication } from "./auth.js";
import { createAppDatabase } from "./database.js";
import { buildAppDomain } from "./domain.js";
import { createAppSchema } from "./schemas/app.js";
import {
  createAppWizardSchema,
  buildBriefRequestSchema
} from "./schemas/app-wizard.js";
import { createRoutingService } from "./services/routing-service.js";
import {
  buildAppDetail,
  type ContainerInspection
} from "./services/app-detail-service.js";
import { computeEnvironmentStatus } from "./services/environment-service.js";
import { registerEnvironmentRoutes } from "./routes/environment.js";
import { registerStorageRoutes } from "./routes/storage.js";
import {
  createDockerOps,
  redeployApp
} from "./services/redeploy-service.js";
import { createAppWithConfig } from "./services/app-creation-service.js";
import { generateBuildBrief } from "./services/build-brief-service.js";
import { getErrorStatusCode } from "./docker-errors.js";
import { createEventRecorder } from "./services/deployment-event-service.js";
import {
  createHealthCheckScheduler,
  createHttpHealthCheckClient
} from "./services/health-check-service.js";
import { decodeDockerLogs as sharedDecodeDockerLogs } from "./services/docker-logs-service.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerLogsRoutes } from "./routes/logs.js";
import { registerEventRoutes } from "./routes/events.js";
import { createGithubClient } from "./services/github-client.js";
import { getDecryptedGithubToken } from "./services/github-credential-service.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerSourceRoutes } from "./routes/source.js";
import { createGithubBuildDockerOps } from "./services/github-deploy-docker-ops.js";
import type { GithubDeployDependencies } from "./services/github-deploy-service.js";
import { registerGithubDeployRoutes } from "./routes/github-deploy.js";
import { verifyGitAvailable } from "./services/github-clone-service.js";
import { createRealHttpProbeClient } from "./services/performance-diagnostics-service.js";
import { registerPerformanceDiagnosticsRoutes } from "./routes/performance-diagnostics.js";

const dockerOps = createDockerOps(docker);

const appDatabase = createAppDatabase(
  process.env.DATABASE_PATH ?? "/data/deployment-platform.sqlite"
);

const routingService = createRoutingService({
  // Default ON: the platform's core value is routing managed apps. It can be
  // explicitly disabled with ROUTING_ENABLED=false.
  enabled: (process.env.ROUTING_ENABLED ?? "true") !== "false",
  docker,
  // The host's caddy/routes directory is mounted into the API container at
  // /app/caddy-routes and into the Caddy container at /etc/caddy/routes, which
  // is exactly what the main Caddyfile imports (`import
  // /etc/caddy/routes/*.caddy`). These defaults must match those mounts.
  routesDirInApi: process.env.CADDY_ROUTES_DIR ?? "/app/caddy-routes",
  routesDirInCaddy: process.env.CADDY_ROUTES_DIR_IN_CADDY ?? "/etc/caddy/routes",
  caddyContainerName:
    process.env.CADDY_CONTAINER_NAME ?? "deployment-platform-caddy",
  mainCaddyfilePathInCaddy:
    process.env.CADDY_MAIN_CONFIG_PATH ?? "/etc/caddy/Caddyfile",
  appsFilename: "apps.caddy"
});

const app = Fastify({
  logger: true
});

/**
 * Apps created before automatic domains existed (Phase 2) have a NULL
 * domain. Assign one deterministically on every boot so pre-existing apps
 * such as sqlite-test become routable without a manual repair step.
 */
function backfillMissingAppDomains(): void {
  const appsWithoutDomain = appDatabase
    .listApps()
    .filter((storedApp) => storedApp.domain === null);

  for (const storedApp of appsWithoutDomain) {
    const domain = buildAppDomain(storedApp.name);
    const conflictingApp = appDatabase.getAppByDomain(domain);

    if (conflictingApp && conflictingApp.id !== storedApp.id) {
      app.log.warn(
        { appId: storedApp.id, appName: storedApp.name, domain },
        "Skipped domain backfill: domain already assigned to a different app"
      );
      continue;
    }

    appDatabase.updateAppDomain(storedApp.id, domain);
  }
}

backfillMissingAppDomains();

await app.register(cors, {
  origin: true
});

await registerAuthentication(app);
await registerEnvironmentRoutes(app, { appDatabase });
await registerStorageRoutes(app, { appDatabase });

const recordEvent = createEventRecorder(appDatabase, app.log);

/**
 * One centralized scheduler drives every managed app's health check.
 * `isContainerRunning` resolves purely by the app's own stored container
 * name — it never accepts or trusts anything from a request.
 */
const healthCheckScheduler = createHealthCheckScheduler({
  appDatabase,
  httpClient: createHttpHealthCheckClient(),
  isContainerRunning: async (containerName) => {
    const inspection = await inspectManagedContainer(containerName);
    return inspection?.state.running ?? false;
  },
  recordEvent,
  logger: app.log
});

await registerHealthRoutes(app, { appDatabase, scheduler: healthCheckScheduler });
await registerMetricsRoutes(app, { appDatabase, docker });
await registerLogsRoutes(app, { appDatabase, docker });
await registerEventRoutes(app, { appDatabase });

/**
 * GitHub remains read-only source-of-truth in this phase: this client is
 * never used to clone, write, or otherwise mutate anything on GitHub.
 * Logging here only ever receives the sanitized fields defined by
 * SourceClientLogEvent — never a token, header, or response body.
 */
const githubClient = createGithubClient({
  log: (event) => app.log.info(event, "GitHub API call")
});

const githubCredentialDeps = {
  appDatabase,
  githubClient,
  logger: app.log
};

const resolveGithubCredential = () => getDecryptedGithubToken({ appDatabase });

const appSourceServiceDeps = {
  appDatabase,
  githubClient,
  resolveCredential: resolveGithubCredential,
  recordEvent,
  logger: app.log
};

await registerGithubRoutes(app, { credentialDeps: githubCredentialDeps, githubClient });
await registerSourceRoutes(app, {
  appDatabase,
  sourceServiceDeps: appSourceServiceDeps,
  githubClient,
  resolveCredential: resolveGithubCredential
});

/**
 * Phase 11: GitHub deployment reuses the exact same `RedeployDockerOps`
 * instance (container create/start/inspect/remove/rename/volume-ensure)
 * as manual redeploys — only the image-build half is new. `isContainerRunning`
 * is the same closure the health-check scheduler already uses, resolving
 * strictly by the app's own stored container name.
 */
const githubBuildDockerOps = createGithubBuildDockerOps(docker);

const deployDeps: GithubDeployDependencies = {
  appDatabase,
  dockerOps: { ...dockerOps, ...githubBuildDockerOps },
  githubClient,
  resolveCredential: resolveGithubCredential,
  reconcileRouting: (db) => routingService.reconcile(db),
  recordEvent,
  healthCheckDeps: {
    httpClient: createHttpHealthCheckClient(),
    isContainerRunning: async (containerName: string) => {
      const inspection = await inspectManagedContainer(containerName);
      return inspection?.state.running ?? false;
    },
    logger: app.log
  }
};

await registerGithubDeployRoutes(app, { appDatabase, deployDeps });

await registerPerformanceDiagnosticsRoutes(app, {
  appDatabase,
  httpProbeClient: createRealHttpProbeClient(),
  recordEvent
});

interface ContainerParams {
  id: string;
}

const protectedContainerNames = new Set([
  "deployment-platform-api",
  "deployment-platform-web"
]);

async function getContainerProtection(id: string) {
  const container = docker.getContainer(id);
  const details = await container.inspect();

  const name = details.Name.replace(/^\//, "");
  const labels = details.Config.Labels ?? {};

  const isSystemContainer =
    protectedContainerNames.has(name) ||
    labels["com.deployment-platform.system"] === "true";

  const isManagedApp =
    labels["com.deployment-platform.managed"] === "true";

  return {
    container,
    details,
    name,
    labels,
    isSystemContainer,
    isManagedApp
  };
}

function sendDockerError(
  reply: FastifyReply,
  error: unknown,
  fallbackMessage: string
) {
  app.log.error(error);

  return reply.code(getErrorStatusCode(error) ?? 500).send({
    success: false,
    message: fallbackMessage
  });
}

async function inspectManagedContainer(
  containerName: string
): Promise<ContainerInspection | null> {
  try {
    const container = docker.getContainer(containerName);
    const details = await container.inspect();

    return {
      id: details.Id,
      state: {
        running: details.State.Running,
        status: details.State.Status,
        exitCode: details.State.ExitCode,
        startedAt: details.State.StartedAt,
        finishedAt: details.State.FinishedAt
      }
    };
  } catch (error) {
    if (getErrorStatusCode(error) === 404) {
      return null;
    }

    throw error;
  }
}

app.get("/", async () => {
  return {
    name: "Deployment Platform API",
    version: "0.4.0",
    status: "running"
  };
});

app.get("/health", async () => {
  return {
    status: "ok",
    timestamp: new Date().toISOString()
  };
});

app.get("/database/health", async () => {
  return {
    healthy: appDatabase.healthCheck(),
    storedApps: appDatabase.listApps().length
  };
});

function isRoutingReady(hasDomain: boolean): boolean {
  // `active` is true only after a real reconciliation validated, applied, and
  // verified the config — never merely because the feature flag is on.
  return hasDomain && routingService.getStatus().active;
}

/**
 * Cheap, DB-only summary for the dashboard's app cards — no Docker calls.
 * Deliberately excludes live CPU/memory (that requires a Docker stats call
 * per app and belongs on the app detail Metrics tab, polled only while
 * visible, not fanned out across every card on every dashboard refresh).
 */
function summarizeAppHealth(appId: number): { state: string; lastCheckedAt: string | null } | null {
  const health = appDatabase.getAppHealthCheck(appId);
  return health ? { state: health.state, lastCheckedAt: health.lastCheckedAt } : null;
}

function latestEventSeverity(appId: number): string | null {
  const [latest] = appDatabase.listDeploymentEvents(appId, { limit: 1 });
  return latest?.severity ?? null;
}

app.get("/apps", async () => {
  return {
    apps: appDatabase.listApps().map((storedApp) => ({
      ...storedApp,
      routingReady: isRoutingReady(storedApp.domain !== null),
      health: summarizeAppHealth(storedApp.id),
      latestEventSeverity: latestEventSeverity(storedApp.id)
    }))
  };
});

const appIdParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

app.get<{ Params: AppIdParams }>("/apps/:id", async (request, reply) => {
  const parsedParams = appIdParamSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return reply.code(400).send({
      success: false,
      message: "Invalid app id"
    });
  }

  const storedApp = appDatabase.getAppById(parsedParams.data.id);

  if (!storedApp) {
    return reply.code(404).send({
      success: false,
      message: "App not found"
    });
  }

  try {
    const inspection = storedApp.containerName
      ? await inspectManagedContainer(storedApp.containerName)
      : null;

    return buildAppDetail(
      storedApp,
      inspection,
      isRoutingReady(storedApp.domain !== null),
      computeEnvironmentStatus(
        storedApp.lastDeployedAt,
        storedApp.environmentTouchedAt
      )
    );
  } catch (error) {
    return sendDockerError(
      reply,
      error,
      "Unable to load app details"
    );
  }
});

app.post<{ Params: AppIdParams }>(
  "/apps/:id/redeploy",
  {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 minute"
      }
    }
  },
  async (request, reply) => {
    const parsedParams = appIdParamSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: "Invalid app id"
      });
    }

    const storedApp = appDatabase.getAppById(parsedParams.data.id);

    if (!storedApp) {
      return reply.code(404).send({
        success: false,
        message: "App not found"
      });
    }

    const result = await redeployApp(
      {
        appDatabase,
        dockerOps,
        reconcileRouting: (db) => routingService.reconcile(db),
        recordEvent
      },
      storedApp.id
    );

    if (!result.success) {
      app.log.error(
        { appId: storedApp.id, message: result.message },
        "App redeploy failed"
      );

      return reply.code(502).send({
        success: false,
        message: result.message
      });
    }

    return reply.send({
      success: true,
      message: result.message,
      containerId: result.containerId
    });
  }
);

app.get("/routing/status", async () => {
  return routingService.getStatus();
});

app.post(
  "/routing/reconcile",
  {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute"
      }
    }
  },
  async () => {
    const status = await routingService.reconcile(appDatabase);

    return {
      success: status.lastReconcileSucceeded === true,
      status
    };
  }
);

app.get("/docker/info", async (_request, reply) => {
  try {
    const info = await docker.info();

    return {
      status: "connected",
      containers: info.Containers,
      containersRunning: info.ContainersRunning,
      containersStopped: info.ContainersStopped,
      images: info.Images,
      dockerVersion: info.ServerVersion,
      operatingSystem: info.OperatingSystem,
      architecture: info.Architecture,
      cpuCount: info.NCPU,
      memoryTotalBytes: info.MemTotal
    };
  } catch (error) {
    app.log.error(error);

    return reply.code(503).send({
      status: "unavailable",
      message: "Unable to connect to Docker"
    });
  }
});

app.get("/containers", async (_request, reply) => {
  try {
    const containers = await docker.listContainers({
      all: true
    });

    return containers.map((container) => {
      const names = container.Names.map((name) =>
        name.replace(/^\//, "")
      );

      const labels = container.Labels ?? {};

      const isSystemContainer =
        names.some((name) =>
          protectedContainerNames.has(name)
        ) ||
        labels["com.deployment-platform.system"] === "true";

      return {
        id: container.Id,
        shortId: container.Id.slice(0, 12),
        names,
        image: container.Image,
        state: container.State,
        status: container.Status,
        created: container.Created,
        ports: container.Ports,
        labels,
        isSystemContainer,
        isManagedApp:
          labels["com.deployment-platform.managed"] === "true"
      };
    });
  } catch (error) {
    app.log.error(error);

    return reply.code(503).send({
      status: "unavailable",
      message: "Unable to list Docker containers"
    });
  }
});

const creationServiceDeps = {
  appDatabase,
  dockerOps,
  buildDomain: buildAppDomain,
  reconcileRouting: (db: typeof appDatabase) => routingService.reconcile(db),
  isRoutingReady,
  recordEvent
};

/**
 * The original, minimal creation endpoint. Kept for backward compatibility
 * with any existing caller of this exact contract — it delegates to the
 * same createAppWithConfig() service the wizard endpoint uses (with empty
 * environment/storage arrays), so there is one authoritative creation
 * implementation, not two that could drift apart. The response shape here
 * is intentionally mapped back to the pre-wizard field names
 * (Docker container id as "id", "state" instead of "status").
 */
app.post(
  "/apps",
  {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute"
      }
    }
  },
  async (request, reply) => {
    const parsedBody = createAppSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: "Invalid app configuration",
        errors: parsedBody.error.flatten()
      });
    }

    const result = await createAppWithConfig(creationServiceDeps, {
      name: parsedBody.data.name,
      image: parsedBody.data.image,
      containerPort: parsedBody.data.containerPort
    });

    if (!result.success || !result.app) {
      app.log.error({ message: result.message }, "App creation failed");

      return reply.code(result.statusCode ?? 502).send({
        success: false,
        message: result.message
      });
    }

    return reply.code(201).send({
      success: true,
      message: result.message,
      app: {
        id: result.app.containerId ?? "",
        shortId: (result.app.containerId ?? "").slice(0, 12),
        name: result.app.name,
        containerName: result.app.containerName,
        image: result.app.image,
        containerPort: result.app.containerPort,
        domain: result.app.domain,
        routingReady: result.app.routingReady,
        state: result.app.status
      }
    });
  }
);

/**
 * The wizard creation endpoint: accepts the full validated payload
 * (environment variables, storage mounts, restart policy) and coordinates
 * app + environment + storage + Docker creation through the same
 * createAppWithConfig() service as POST /apps above.
 */
app.post(
  "/apps/wizard",
  {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute"
      }
    }
  },
  async (request, reply) => {
    const parsedBody = createAppWizardSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: "Invalid app configuration",
        errors: parsedBody.error.flatten()
      });
    }

    const result = await createAppWithConfig(creationServiceDeps, {
      name: parsedBody.data.name,
      image: parsedBody.data.image,
      containerPort: parsedBody.data.containerPort,
      restartPolicy: parsedBody.data.restartPolicy,
      environmentVariables: parsedBody.data.environmentVariables,
      storageMounts: parsedBody.data.storageMounts
    });

    if (!result.success || !result.app) {
      app.log.error({ message: result.message }, "Wizard app creation failed");

      return reply.code(result.statusCode ?? 502).send({
        success: false,
        message: result.message
      });
    }

    return reply.code(201).send({
      success: true,
      message: result.message,
      app: result.app
    });
  }
);

/**
 * Deterministic, side-effect-free build-brief generation. No app is
 * created or touched — this only assembles text from the request body, so
 * it's safe to call repeatedly as the wizard's fields change.
 */
app.post(
  "/apps/wizard/brief",
  {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: "1 minute"
      }
    }
  },
  async (request, reply) => {
    const parsedBody = buildBriefRequestSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: "Invalid build brief request",
        errors: parsedBody.error.flatten()
      });
    }

    const domain = buildAppDomain(parsedBody.data.appName);

    const brief = generateBuildBrief({
      appName: parsedBody.data.appName,
      domain,
      image: parsedBody.data.image,
      containerPort: parsedBody.data.containerPort,
      runtime: parsedBody.data.runtime,
      description: parsedBody.data.description,
      startCommand: parsedBody.data.startCommand,
      healthCheckPath: parsedBody.data.healthCheckPath,
      environmentVariables: parsedBody.data.environmentVariables,
      storageMounts: parsedBody.data.storageMounts
    });

    return reply.send({
      success: true,
      domain,
      brief
    });
  }
);

/**
 * Best-effort lifecycle event for a container action — only recorded when
 * the container belongs to a managed app the platform actually tracks.
 * Never blocks or fails the action itself (recordEvent never throws).
 */
function recordContainerActionEvent(
  protection: Awaited<ReturnType<typeof getContainerProtection>>,
  eventType: "container-started" | "container-stopped" | "container-restarted",
  actionLabel: string
): void {
  if (!protection.isManagedApp) {
    return;
  }

  const appName = protection.labels["com.deployment-platform.app-name"];
  const storedApp = appName ? appDatabase.getAppByName(appName) : null;

  if (!storedApp) {
    return;
  }

  recordEvent({
    appId: storedApp.id,
    eventType,
    severity: "info",
    message: `${storedApp.name} was ${actionLabel}`
  });
}

app.post<{ Params: ContainerParams }>(
  "/containers/:id/start",
  async (request, reply) => {
    try {
      const protection = await getContainerProtection(
        request.params.id
      );

      await protection.container.start();
      recordContainerActionEvent(protection, "container-started", "started");

      return {
        success: true,
        action: "started",
        containerId: request.params.id
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to start container"
      );
    }
  }
);

app.post<{ Params: ContainerParams }>(
  "/containers/:id/stop",
  async (request, reply) => {
    try {
      const protection = await getContainerProtection(
        request.params.id
      );

      if (protection.isSystemContainer) {
        return reply.code(403).send({
          success: false,
          message:
            "System containers cannot be stopped from the dashboard"
        });
      }

      await protection.container.stop({
        t: 10
      });
      recordContainerActionEvent(protection, "container-stopped", "stopped");

      return {
        success: true,
        action: "stopped",
        containerId: request.params.id
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to stop container"
      );
    }
  }
);

app.post<{ Params: ContainerParams }>(
  "/containers/:id/restart",
  async (request, reply) => {
    try {
      const protection = await getContainerProtection(
        request.params.id
      );

      if (protection.isSystemContainer) {
        return reply.code(403).send({
          success: false,
          message:
            "System containers cannot be restarted from the dashboard"
        });
      }

      await protection.container.restart({
        t: 10
      });
      recordContainerActionEvent(protection, "container-restarted", "restarted");

      return {
        success: true,
        action: "restarted",
        containerId: request.params.id
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to restart container"
      );
    }
  }
);

app.get<{ Params: ContainerParams }>(
  "/containers/:id/logs",
  async (request, reply) => {
    try {
      const container = docker.getContainer(
        request.params.id
      );

      const logs = await container.logs({
        stdout: true,
        stderr: true,
        timestamps: true,
        tail: 200
      });

      return {
        containerId: request.params.id,
        logs: sharedDecodeDockerLogs(logs)
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to read container logs"
      );
    }
  }
);

app.delete<{ Params: ContainerParams }>(
  "/apps/:id",
  async (request, reply) => {
    try {
      const protection = await getContainerProtection(
        request.params.id
      );

      if (protection.isSystemContainer) {
        return reply.code(403).send({
          success: false,
          message: "System containers cannot be deleted"
        });
      }

      if (!protection.isManagedApp) {
        return reply.code(403).send({
          success: false,
          message:
            "Only apps created by Deployment Platform can be deleted here"
        });
      }

      const appName =
        protection.labels[
          "com.deployment-platform.app-name"
        ];

      await protection.container.remove({
        force: true,
        v: true
      });

      if (appName) {
        const storedApp = appDatabase.getAppByName(appName);

        if (storedApp) {
          appDatabase.deleteApp(storedApp.id);

          if (storedApp.domain) {
            await routingService.reconcile(appDatabase);
          }
        }
      }

      return {
        success: true,
        action: "deleted",
        containerId: request.params.id,
        name: protection.name,
        appName: appName ?? null
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to delete app"
      );
    }
  }
);

const start = async (): Promise<void> => {
  try {
    await app.listen({
      host: "0.0.0.0",
      port: 3001
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  const startupRoutingStatus = await routingService.reconcile(appDatabase);

  if (startupRoutingStatus.enabled && !startupRoutingStatus.lastReconcileSucceeded) {
    app.log.error(
      { routingStatus: startupRoutingStatus },
      "Failed to reconcile routing on startup"
    );
  }

  // Non-fatal: the API serves everything else fine without git — only
  // GitHub deployments need it, and those already fail with a clear,
  // specific error if it's missing. This just puts that fact in the
  // startup logs immediately instead of only surfacing on the first
  // deploy attempt.
  const gitAvailability = await verifyGitAvailable();
  if (!gitAvailability.available) {
    app.log.error(
      { reason: gitAvailability.reason },
      "git is not available in this runtime image — GitHub deployments will fail until it is installed"
    );
  } else {
    app.log.info({ version: gitAvailability.version }, "git is available for GitHub deployments");
  }

  healthCheckScheduler.start();
};

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");

  // The scheduler's own timer is unref'd and never keeps the process alive
  // on its own, but stopping it explicitly here still gives an orderly
  // shutdown rather than leaving an in-flight check racing the exit.
  healthCheckScheduler.stop();

  try {
    await app.close();
  } catch (error) {
    app.log.error(error, "Error while closing the server");
  }

  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

await start();