import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { docker } from "./docker.js";
import { registerAuthentication } from "./auth.js";
import { createAppDatabase } from "./database.js";
import { buildAppDomain, resolveAppDomainChoice, shouldBackfillAppDomain } from "./domain.js";
import { createAppSchema, updateAppRoutingSchema } from "./schemas/app.js";
import {
  createAppWizardWithCompanionsSchema,
  buildBriefRequestSchema
} from "./schemas/app-wizard.js";
import { deployTemplateStack } from "./services/template-deployment-service.js";
import {
  createInstallJob,
  NULL_REPORTER,
  subscribeToInstall
} from "./services/install-progress-service.js";
import {
  dismissDeployProgress,
  listDeployProgress,
  subscribeToDeployProgress
} from "./services/deploy-progress-service.js";
import { createRoutingService } from "./services/routing-service.js";
import { updateAppRouting } from "./services/app-routing-service.js";
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
import {
  createDeletionDockerOps,
  deleteAppWithIdempotency,
  deleteManagedAppByAppId
} from "./services/app-deletion-service.js";
import { readIdempotencyKeyHeader } from "./services/idempotency.js";
import {
  buildManagedContainerRuntimeMap,
  resolveAppRuntime,
  type AppRuntimeState
} from "./services/app-runtime-service.js";
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
import { registerIrcAdminRoutes } from "./routes/irc-admin.js";
import { registerIrcBotAdminRoutes } from "./routes/irc-bot-admin.js";
import { registerBlueprintRoutes } from "./routes/blueprint.js";
import { registerLogsRoutes } from "./routes/logs.js";
import { registerEventRoutes } from "./routes/events.js";
import { createGithubClient } from "./services/github-client.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerGithubAppRoutes } from "./routes/github-app.js";
import { loadGithubAppConfig, describeGithubAppConfig } from "./services/github-app-config.js";
import { createGithubAppStateStore } from "./services/github-app-state-service.js";
import { resolveGithubToken } from "./services/github-token-service.js";
import { registerSourceRoutes } from "./routes/source.js";
import { createGithubBuildDockerOps } from "./services/github-deploy-docker-ops.js";
import { deployFromGithub, type GithubDeployDependencies } from "./services/github-deploy-service.js";
import { registerGithubDeployRoutes } from "./routes/github-deploy.js";
import { registerDeploymentRoutes } from "./routes/deployments.js";
import { registerDeploymentSettingsRoutes } from "./routes/deployment-settings.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerPortsRoutes } from "./routes/ports.js";
import { registerImageRoutes } from "./routes/images.js";
import { createImagePruneDockerOps } from "./services/image-prune-service.js";
import { createBackupArchive } from "./services/backup-service.js";
import { runScheduledBackup } from "./services/backup-schedule-service.js";
import { createBackupScheduler } from "./services/backup-scheduler.js";
import { notifyDeployEvent, shouldNotify } from "./services/notification-service.js";
import {
  registerPlatformSettingsRoutes,
  readAutoBackupConfig,
  readNotificationConfig,
  AUTO_BACKUP_LAST_RUN_KEY
} from "./routes/platform-settings.js";
import type { RecordEventFn } from "./services/deployment-event-service.js";
import { createAutoDeployScheduler } from "./services/auto-deploy-service.js";
import {
  createImageUpdateChecker,
  createImageUpdateCheckDockerOps
} from "./services/image-update-check-service.js";
import type { RevertDependencies } from "./services/revert-service.js";
import { verifyGitAvailable } from "./services/github-clone-service.js";
import { createRealHttpProbeClient } from "./services/performance-diagnostics-service.js";
import { registerPerformanceDiagnosticsRoutes } from "./routes/performance-diagnostics.js";

const dockerOps = createDockerOps(docker);

// How often the auto-deploy poller checks each enabled app's branch for a new
// commit. Floored at 15s so a misconfigured value can't hammer GitHub.
const AUTO_DEPLOY_POLL_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.AUTO_DEPLOY_POLL_INTERVAL_MS) || 60_000
);

const DATABASE_PATH = process.env.DATABASE_PATH ?? "/data/deployment-platform.sqlite";
const BACKUPS_DIR = process.env.BACKUPS_DIR ?? "/data/backups";

const appDatabase = createAppDatabase(DATABASE_PATH);

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

// Raw binary parser for backup uploads (POST /settings/restore). The route
// sets its own generous bodyLimit; no other route consumes octet-stream.
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer" },
  (_request, body, done) => done(null, body)
);

/**
 * Apps created before automatic domains existed (Phase 2) have a NULL
 * domain. Assign one deterministically on every boot so pre-existing apps
 * such as sqlite-test become routable without a manual repair step.
 *
 * Explicitly internal-only apps (Phase 13 — `internal_only`) are permanently
 * excluded: their null domain is a deliberate, persisted choice, not a
 * legacy gap, so they must never be assigned a domain here — otherwise an
 * app created with no public route would silently become public again on
 * the platform's next restart.
 */
function backfillMissingAppDomains(): void {
  const appsWithoutDomain = appDatabase
    .listApps()
    .filter(shouldBackfillAppDomain);

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

/**
 * Reclaim deployment locks abandoned by a previous process. Reaching this
 * line means the API is only now starting, which is itself proof that no
 * deployment held by an earlier process is still running — so any lock old
 * enough to be stale is definitively orphaned. Without this, a crash
 * mid-deploy left an app permanently unable to deploy, rejecting every
 * attempt with "a deployment for this app is already in progress".
 */
const reclaimedLocks = appDatabase.releaseStaleDeploymentLocks();
if (reclaimedLocks > 0) {
  app.log.warn(
    { reclaimedLocks },
    "Released stale GitHub deployment lock(s) left behind by a previous process"
  );
}

await app.register(cors, {
  origin: true
});

const ADMIN_PASSWORD_HASH_SETTING = "admin_password_hash_override";
await registerAuthentication(app, {
  getStoredPasswordHash: () => appDatabase.getSetting(ADMIN_PASSWORD_HASH_SETTING),
  setStoredPasswordHash: (hash) => appDatabase.setSetting(ADMIN_PASSWORD_HASH_SETTING, hash)
});
await registerEnvironmentRoutes(app, { appDatabase });
await registerStorageRoutes(app, { appDatabase });

const baseRecordEvent = createEventRecorder(appDatabase, app.log);
// Fire-and-forget deploy notifications for outcome events, layered on top of
// the normal event recorder so every deploy path gets it for free.
const recordEvent: RecordEventFn = (input) => {
  baseRecordEvent(input);
  if (shouldNotify(input.eventType)) {
    void notifyDeployEvent(readNotificationConfig(appDatabase), {
      eventType: input.eventType,
      message: input.message,
      severity: input.severity
    }).catch(() => undefined);
  }
};

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
await registerIrcAdminRoutes(app, { appDatabase, docker });
await registerIrcBotAdminRoutes(app, { appDatabase, docker });
registerBlueprintRoutes(app, { appDatabase, docker });
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

/**
 * GitHub App configuration is optional at startup — an unconfigured app
 * means every route below simply reports "not configured" (see
 * github-app-config.ts) and resolveGithubToken() falls straight through to
 * the manual PAT, rather than the process failing to start. This keeps the
 * platform fully usable for manual-image deployments and the advanced PAT
 * flow with zero GitHub App setup.
 */
const githubAppConfig = loadGithubAppConfig();
app.log.info(describeGithubAppConfig(githubAppConfig), "GitHub App configuration");
const githubAppStateStore = createGithubAppStateStore();

const resolveGithubCredential = () =>
  resolveGithubToken({ appDatabase, githubAppConfig, logger: app.log });

const appSourceServiceDeps = {
  appDatabase,
  githubClient,
  resolveCredential: resolveGithubCredential,
  recordEvent,
  logger: app.log
};

await registerGithubRoutes(app, { credentialDeps: githubCredentialDeps, githubClient, resolveCredential: resolveGithubCredential });
await registerGithubAppRoutes(app, {
  appDatabase,
  githubAppConfig,
  stateStore: githubAppStateStore,
  logger: app.log
});
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

// How long a single image build may run before it's aborted. Floored at 5
// minutes so a misconfigured value can't kill legitimate builds; a real
// multi-stage build with no cache to reuse takes well over the old 6-minute
// hard default on a small VPS.
const BUILD_TIMEOUT_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.BUILD_TIMEOUT_MS) || 20 * 60 * 1000
);

const deployDeps: GithubDeployDependencies = {
  appDatabase,
  dockerOps: { ...dockerOps, ...githubBuildDockerOps },
  githubClient,
  resolveCredential: resolveGithubCredential,
  reconcileRouting: (db) => routingService.reconcile(db),
  recordEvent,
  buildTimeoutMs: BUILD_TIMEOUT_MS,
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

// Revert reuses the same Docker operations as GitHub deploy — the merged
// `deployDeps.dockerOps` already exposes both the redeploy container swap
// and `imageExists` — plus the same routing reconcile and event recorder.
const revertDeps: RevertDependencies = {
  appDatabase,
  dockerOps: deployDeps.dockerOps,
  reconcileRouting: (db) => routingService.reconcile(db),
  recordEvent
};

await registerDeploymentRoutes(app, { appDatabase, revertDeps });

await registerDeploymentSettingsRoutes(app, { appDatabase });

await registerSettingsRoutes(app, { appDatabase, dbPath: DATABASE_PATH, backupsDir: BACKUPS_DIR });

await registerPortsRoutes(app, { appDatabase });

await registerImageRoutes(app, { appDatabase, imageOps: createImagePruneDockerOps(docker) });

// Scheduled backups: snapshot the DB to /data/backups on an interval, with
// retention. Reuses the same archive builder as the manual download.
const runScheduledBackupNow = () =>
  runScheduledBackup({
    createArchive: () =>
      createBackupArchive({
        snapshotTo: (dest) => appDatabase.db.exec(`VACUUM INTO '${dest}'`),
        schemaVersion:
          (appDatabase.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
            v: number | null;
          }).v ?? 0,
        appCount: appDatabase.listApps().length
      }),
    backupsDir: BACKUPS_DIR,
    retention: readAutoBackupConfig(appDatabase).retention
  }).then(() => undefined);

const backupScheduler = createBackupScheduler({
  getConfig: () => readAutoBackupConfig(appDatabase),
  getLastRunAt: () => {
    const raw = appDatabase.getSetting(AUTO_BACKUP_LAST_RUN_KEY);
    return raw ? Number(raw) : null;
  },
  setLastRunAt: (ms) => appDatabase.setSetting(AUTO_BACKUP_LAST_RUN_KEY, String(ms)),
  runBackup: () => runScheduledBackupNow(),
  logger: app.log
});

// Periodically checks every plain-image app (no app_sources row — GitHub-built
// apps have their own auto-deploy pipeline) for a newer registry image than
// what's currently running, so the panel can show a "redeploy to update"
// indicator without the user needing to check manually. A few minutes rather
// than hourly, since a `docker pull` against an already-current image is
// cheap (no new layers to fetch) and the point of the indicator is to be
// close to real-time.
const IMAGE_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

const imageUpdateChecker = createImageUpdateChecker({
  listCandidateApps: () =>
    appDatabase.listApps().map((storedApp) => ({
      id: storedApp.id,
      containerId: storedApp.containerId,
      image: storedApp.image
    })),
  hasAppSource: (appId) => appDatabase.getAppSource(appId) !== null,
  dockerOps: createImageUpdateCheckDockerOps(docker),
  logger: app.log,
  tickIntervalMs: IMAGE_UPDATE_CHECK_INTERVAL_MS
});

await registerPlatformSettingsRoutes(app, {
  appDatabase,
  backupsDir: BACKUPS_DIR,
  runBackupNow: () => runScheduledBackupNow()
});

// Auto-deploy: poll each auto-deploy-enabled GitHub app's branch and deploy
// when its HEAD commit changes. Reuses the same deploy pipeline and GitHub
// client as a manual deploy; the durable deployment lock prevents overlap
// with a manual deploy or a still-running previous tick.
const autoDeployScheduler = createAutoDeployScheduler({
  appDatabase,
  intervalMs: AUTO_DEPLOY_POLL_INTERVAL_MS,
  resolveBranchHead: async (candidate) => {
    if (!candidate.repositoryOwner || !candidate.repositoryName) {
      return null;
    }

    const credential = await resolveGithubCredential();
    if (!credential.success) {
      return null;
    }

    return githubClient.resolveBranchCommit(
      credential.token,
      candidate.repositoryOwner,
      candidate.repositoryName,
      candidate.branch
    );
  },
  triggerDeploy: async (appId) => {
    const result = await deployFromGithub(deployDeps, appId, {});
    return result.success;
  },
  logger: app.log
});

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
 * One Docker call for the whole Apps list (not one per app): returns a map
 * of managed container name -> its live state. Returns null if Docker is
 * unreachable, so the list endpoint degrades to stored status instead of
 * failing outright or wrongly reporting every app as missing. The pure
 * mapping/resolution lives in app-runtime-service.ts so it can be unit
 * tested without a Docker daemon.
 */
async function loadManagedContainerRuntime(): Promise<Map<string, AppRuntimeState> | null> {
  try {
    const containers = await docker.listContainers({ all: true });
    return buildManagedContainerRuntimeMap(
      containers.map((container) => ({
        names: container.Names,
        state: container.State ?? null,
        labels: container.Labels ?? undefined
      }))
    );
  } catch (error) {
    app.log.error(error, "Unable to list containers for app runtime state");
    return null;
  }
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
  // Cross-check live Docker state so a database-managed app whose container
  // has gone missing stays listed (with a truthful runtime state) rather
  // than silently disappearing or reporting a stale "running".
  const runtimeByName = await loadManagedContainerRuntime();

  return {
    apps: appDatabase.listApps().map((storedApp) => ({
      ...storedApp,
      routingReady: isRoutingReady(storedApp.domain !== null),
      health: summarizeAppHealth(storedApp.id),
      latestEventSeverity: latestEventSeverity(storedApp.id),
      runtime: resolveAppRuntime(storedApp.containerName, runtimeByName),
      publishedPorts: appDatabase.listAppPublishedPorts(storedApp.id),
      imageUpdateAvailable: imageUpdateChecker.getStatus(storedApp.id)?.updateAvailable ?? false,
      imageUpdateCheckedAt: imageUpdateChecker.getStatus(storedApp.id)?.checkedAt ?? null
    }))
  };
});

app.post(
  "/apps/image-updates/check-now",
  { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
  async (_request, reply) => {
    try {
      await imageUpdateChecker.runOnce();
      const updatesAvailable = appDatabase
        .listApps()
        .filter((storedApp) => imageUpdateChecker.getStatus(storedApp.id)?.updateAvailable).length;
      return { success: true, updatesAvailable };
    } catch (error) {
      app.log.error(error, "Manual image update check failed");
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : "Update check failed."
      });
    }
  }
);

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
      ),
      appDatabase.listAppPublishedPorts(storedApp.id),
      imageUpdateChecker.getStatus(storedApp.id)
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

    // An app linked to a GitHub repository has no meaningful "stored image"
    // to recreate from — its real image is built from source and swapped in
    // by deployFromGithub. Recreating from app.image would pull the
    // create-time placeholder (nginx:alpine) and destroy the running build.
    // So Redeploy on a repo-linked app rebuilds from source, exactly like
    // the Source tab's "Deploy from GitHub".
    const source = appDatabase.getAppSource(storedApp.id);

    if (source) {
      const deployResult = await deployFromGithub(deployDeps, storedApp.id, {});

      if (!deployResult.success) {
        app.log.error(
          { appId: storedApp.id, message: deployResult.message },
          "App redeploy (from GitHub source) failed"
        );

        return reply.code(502).send({
          success: false,
          message: deployResult.message,
          rolledBack: deployResult.rolledBack
        });
      }

      return reply.send({
        success: true,
        message: deployResult.message,
        containerId: deployResult.containerId
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

const appResourcesSchema = z.object({
  memoryLimitMb: z.number().int().min(16).max(131072).nullable(),
  cpuLimit: z.number().min(0.1).max(64).nullable()
});

/**
 * Sets an app's optional memory/CPU caps and applies them immediately by
 * recreating the container. The container is recreated from its *currently
 * running* image (not app.image, which is a stale placeholder for
 * GitHub-built apps) so the app keeps running its real image.
 */
app.patch<{ Params: AppIdParams }>(
  "/apps/:id/resources",
  { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
  async (request, reply) => {
    const parsedParams = appIdParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const parsedBody = appResourcesSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: "Invalid resource limits",
        errors: parsedBody.error.flatten()
      });
    }

    const storedApp = appDatabase.getAppById(parsedParams.data.id);
    if (!storedApp) {
      return reply.code(404).send({ success: false, message: "App not found" });
    }

    appDatabase.updateAppResources(storedApp.id, {
      memoryLimitMb: parsedBody.data.memoryLimitMb,
      cpuLimit: parsedBody.data.cpuLimit
    });

    // Recreate with the image the container is actually running.
    let currentImage: string | undefined;
    if (storedApp.containerName) {
      try {
        const info = await docker.getContainer(storedApp.containerName).inspect();
        currentImage = info.Config?.Image ?? info.Image;
      } catch {
        currentImage = undefined;
      }
    }

    const result = await redeployApp(
      {
        appDatabase,
        dockerOps,
        reconcileRouting: (db) => routingService.reconcile(db),
        recordEvent
      },
      storedApp.id,
      currentImage ? { imageOverride: currentImage, skipPull: true } : {}
    );

    if (!result.success) {
      return reply.code(502).send({
        success: false,
        message: `Limits were saved, but applying them failed: ${result.message}`
      });
    }

    return reply.send({
      success: true,
      message: "Resource limits updated and applied.",
      memoryLimitMb: parsedBody.data.memoryLimitMb,
      cpuLimit: parsedBody.data.cpuLimit
    });
  }
);

/**
 * Toggles an app between public (generated default domain, or a custom
 * domain) and internal-only (no domain, never routed), or changes a public
 * app's domain. Container and volumes are untouched — see
 * services/app-routing-service.ts.
 */
app.patch<{ Params: AppIdParams }>(
  "/apps/:id/routing",
  {
    config: {
      rateLimit: {
        max: 10,
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

    const parsedBody = updateAppRoutingSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: "Invalid routing configuration",
        errors: parsedBody.error.flatten()
      });
    }

    const result = await updateAppRouting(
      {
        appDatabase,
        reconcileRouting: (db) => routingService.reconcile(db),
        recordEvent
      },
      parsedParams.data.id,
      {
        internalOnly: parsedBody.data.internalOnly,
        ...(parsedBody.data.customDomain ? { customDomain: parsedBody.data.customDomain } : {})
      }
    );

    if (!result.success) {
      app.log.error({ appId: parsedParams.data.id, message: result.message }, "App routing update failed");

      return reply.code(result.statusCode ?? 502).send({
        success: false,
        message: result.message
      });
    }

    return reply.send({
      success: true,
      message: result.message,
      domain: result.domain,
      internalOnly: result.internalOnly
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
 * Validates a client-supplied install id before it is used as a map key or
 * echoed back in a stream. Deliberately narrow — a UUID from
 * crypto.randomUUID() is all the browser ever sends.
 */
/**
 * Turns a zod failure into a short, operator-readable summary naming the
 * fields that were rejected and why, e.g.
 * `companions.0.storageMounts.0.containerPath: This path is reserved and
 * cannot be used for storage`. Capped so a pathological payload can't
 * produce an unbounded message.
 */
function summarizeValidationIssues(error: z.ZodError): string {
  const MAX_ISSUES = 3;

  const issues = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  const remaining = error.issues.length - issues.length;

  return remaining > 0
    ? `${issues.join("; ")} (and ${remaining} more)`
    : issues.join("; ");
}

function parseInstallId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return /^[A-Za-z0-9-]{8,64}$/.test(trimmed) ? trimmed : null;
}

const deletionServiceDeps = {
  appDatabase,
  dockerOps: createDeletionDockerOps(docker),
  reconcileRouting: (db: typeof appDatabase) => routingService.reconcile(db)
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

    const idempotency = readIdempotencyKeyHeader(
      request.headers["idempotency-key"]
    );

    if (idempotency.present && !idempotency.valid) {
      return reply.code(400).send({
        success: false,
        message: "Invalid Idempotency-Key header"
      });
    }

    const result = await createAppWithConfig(creationServiceDeps, {
      name: parsedBody.data.name,
      image: parsedBody.data.image,
      containerPort: parsedBody.data.containerPort,
      internalOnly: parsedBody.data.internalOnly,
      ...(parsedBody.data.customDomain ? { customDomain: parsedBody.data.customDomain } : {}),
      ...(idempotency.present ? { idempotencyKey: idempotency.key } : {})
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
        internalOnly: result.app.internalOnly,
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
    const parsedBody = createAppWizardWithCompanionsSchema.safeParse(request.body);

    if (!parsedBody.success) {
      // Name the offending field(s) in the message itself. A bare
      // "Invalid app configuration" left an operator staring at a rejected
      // install with nothing to act on — the specifics were only ever in
      // the `errors` payload, which the UI doesn't render.
      return reply.code(400).send({
        success: false,
        message: `Invalid app configuration: ${summarizeValidationIssues(parsedBody.error)}`,
        errors: parsedBody.error.flatten()
      });
    }

    const idempotency = readIdempotencyKeyHeader(
      request.headers["idempotency-key"]
    );

    if (idempotency.present && !idempotency.valid) {
      return reply.code(400).send({
        success: false,
        message: "Invalid Idempotency-Key header"
      });
    }

    // An optional client-supplied id for live progress. The browser opens
    // the SSE stream for this id BEFORE posting, so nothing is missed; when
    // absent, creation runs exactly as before with no tracking at all.
    const installId = parseInstallId(request.headers["x-install-id"]);
    const reporter = installId ? createInstallJob(installId) : NULL_REPORTER;

    const mainInput = {
      name: parsedBody.data.name,
      image: parsedBody.data.image,
      containerPort: parsedBody.data.containerPort,
      restartPolicy: parsedBody.data.restartPolicy,
      memoryLimitMb: parsedBody.data.memoryLimitMb ?? null,
      cpuLimit: parsedBody.data.cpuLimit ?? null,
      environmentVariables: parsedBody.data.environmentVariables,
      storageMounts: parsedBody.data.storageMounts,
      publishedPorts: parsedBody.data.publishedPorts,
      internalOnly: parsedBody.data.internalOnly,
      ...(parsedBody.data.customDomain ? { customDomain: parsedBody.data.customDomain } : {}),
      ...(idempotency.present ? { idempotencyKey: idempotency.key } : {})
    };

    // A multi-service template (companions present) goes through the
    // template stack deployer, which creates the backing services first and
    // rolls the whole install back if any part fails. Everything else takes
    // the unchanged single-app path.
    if (parsedBody.data.companions.length > 0) {
      const stack = await deployTemplateStack(
        {
          createApp: (input) => createAppWithConfig(creationServiceDeps, input, reporter),
          removeApp: async (appId) => {
            const removal = await deleteManagedAppByAppId(deletionServiceDeps, appId);
            return removal.success;
          },
          beginProgress: (names) => reporter.begin(names)
        },
        { main: mainInput, companions: parsedBody.data.companions }
      );

      if (!stack.success || !stack.app) {
        app.log.error(
          { message: stack.message, rollback: stack.rollback },
          "Template stack creation failed"
        );

        reporter.fail(stack.message);

        return reply.code(stack.statusCode ?? 502).send({
          success: false,
          message: stack.message,
          rollback: stack.rollback
        });
      }

      reporter.succeed();

      return reply.code(201).send({
        success: true,
        message: stack.message,
        app: stack.app,
        companions: stack.companions ?? []
      });
    }

    reporter.begin([mainInput.name]);

    const result = await createAppWithConfig(creationServiceDeps, mainInput, reporter);

    if (!result.success || !result.app) {
      app.log.error({ message: result.message }, "Wizard app creation failed");

      reporter.fail(result.message);

      return reply.code(result.statusCode ?? 502).send({
        success: false,
        message: result.message
      });
    }

    reporter.succeed();

    return reply.code(201).send({
      success: true,
      message: result.message,
      app: result.app
    });
  }
);

/**
 * Live progress for every in-flight GitHub deployment, as Server-Sent
 * Events. Deliberately NOT per-app: the panel shows one site-wide overlay
 * that must keep updating as the operator navigates between pages, so a
 * single connection carries all active deployments rather than requiring a
 * subscription per app.
 */
app.get("/deployments/progress", async (request, reply) => {
  reply.hijack();
  const raw = reply.raw;

  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  raw.write("retry: 3000\n\n");

  function send(event: string, data: unknown): void {
    if (!raw.writableEnded) {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  // Anything already running (or recently finished) is delivered up front,
  // so an operator who opens the panel mid-deploy sees it immediately
  // rather than waiting for the next change.
  send("snapshot", { deployments: listDeployProgress() });

  const heartbeat = setInterval(() => {
    if (!raw.writableEnded) {
      raw.write(": ping\n\n");
    }
  }, 25000);

  const unsubscribe = subscribeToDeployProgress((progress) => {
    send("progress", progress);
  });

  let closed = false;

  function cleanup(): void {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!raw.writableEnded) {
      raw.end();
    }
  }

  request.raw.on("close", cleanup);
});

/** Clears a finished deployment from the overlay. */
app.delete("/deployments/progress/:appId", async (request, reply) => {
  const params = z
    .object({ appId: z.coerce.number().int().positive() })
    .safeParse(request.params);

  if (!params.success) {
    return reply.code(400).send({ success: false, message: "Invalid app id" });
  }

  const dismissed = dismissDeployProgress(params.data.appId);

  return reply.send({
    success: true,
    dismissed,
    message: dismissed
      ? "Deployment dismissed."
      : "No finished deployment to dismiss for that app."
  });
});

/**
 * Live progress for an in-flight install, as Server-Sent Events. The client
 * generates the id, opens this stream, and only then posts to
 * /apps/wizard with the same id in X-Install-Id — so the stream is already
 * listening before any work starts and no early update is lost.
 *
 * Follows the same hijack/heartbeat/cleanup shape as the container log
 * stream in routes/logs.ts.
 */
app.get("/apps/wizard/install/:installId/progress", async (request, reply) => {
  const installId = parseInstallId(
    (request.params as { installId?: string }).installId
  );

  if (!installId) {
    return reply.code(400).send({ success: false, message: "Invalid install id" });
  }

  reply.hijack();
  const raw = reply.raw;

  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  raw.write("retry: 3000\n\n");

  function send(event: string, data: unknown): void {
    if (!raw.writableEnded) {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  const heartbeat = setInterval(() => {
    if (!raw.writableEnded) {
      raw.write(": ping\n\n");
    }
  }, 25000);

  let unsubscribe: (() => void) | null = null;
  let closed = false;

  function cleanup(): void {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    if (!raw.writableEnded) {
      raw.end();
    }
  }

  request.raw.on("close", cleanup);

  // The POST that creates the job may not have arrived yet — this stream is
  // opened first on purpose. Poll briefly for the job to appear rather than
  // reporting a spurious "not found" for an install that is about to start.
  const waitStarted = Date.now();
  const WAIT_TIMEOUT_MS = 15_000;

  const attach = () => {
    if (closed) {
      return;
    }

    unsubscribe = subscribeToInstall(installId, (progress) => {
      send("progress", progress);

      if (progress.status !== "running") {
        // Give the event a tick to flush before closing the stream.
        setTimeout(cleanup, 50);
      }
    });

    if (unsubscribe) {
      return;
    }

    if (Date.now() - waitStarted > WAIT_TIMEOUT_MS) {
      send("error", { message: "No install with that id is running." });
      cleanup();
      return;
    }

    setTimeout(attach, 200);
  };

  attach();
});

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

    const domainChoice = resolveAppDomainChoice(parsedBody.data.appName, {
      internalOnly: parsedBody.data.internalOnly,
      customDomain: parsedBody.data.customDomain
    });

    if (!domainChoice.ok) {
      return reply.code(400).send({
        success: false,
        message: domainChoice.error
      });
    }

    const domain = domainChoice.domain;

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
    const idempotency = readIdempotencyKeyHeader(
      request.headers["idempotency-key"]
    );

    if (idempotency.present && !idempotency.valid) {
      return reply.code(400).send({
        success: false,
        message: "Invalid Idempotency-Key header"
      });
    }

    const result = await deleteAppWithIdempotency(
      deletionServiceDeps,
      request.params.id,
      idempotency.present ? idempotency.key : undefined
    );

    if (!result.success) {
      app.log.error({ message: result.message }, "App deletion failed");
      return reply.code(result.statusCode ?? 502).send({
        success: false,
        message: result.message
      });
    }

    return result;
  }
);

/**
 * Recovery deletion by database app id — used by the Apps page / detail for
 * an app whose Docker container has gone MISSING. The primary DELETE route
 * above resolves the app from a live container inspection, which is
 * impossible when there is no container; this one resolves by app id and
 * tolerates an already-gone runtime, so a database-managed app is never
 * un-deletable just because its container disappeared.
 */
app.delete<{ Params: AppIdParams }>(
  "/apps/by-app-id/:id",
  async (request, reply) => {
    const parsedParams = appIdParamSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const result = await deleteManagedAppByAppId(
      deletionServiceDeps,
      parsedParams.data.id
    );

    if (!result.success) {
      app.log.error({ message: result.message }, "App deletion (by id) failed");
      return reply.code(result.statusCode ?? 502).send({
        success: false,
        message: result.message
      });
    }

    return result;
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
  autoDeployScheduler.start();
  backupScheduler.start();
  imageUpdateChecker.start();
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
  autoDeployScheduler.stop();
  backupScheduler.stop();
  imageUpdateChecker.stop();

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