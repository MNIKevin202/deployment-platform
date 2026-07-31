import { randomBytes } from "node:crypto";
import { relative } from "node:path";
import type { AppDatabase } from "../database.js";
import { buildContainerEnvArray } from "./environment-service.js";
import { buildVolumeMounts } from "./storage-service.js";
import { buildResourceHostConfig } from "./resource-limits.js";
import { buildPublishedPortConfig } from "./port-bindings.js";
import type { RedeployDockerOps } from "./redeploy-service.js";
import type { GithubBuildDockerOps } from "./github-deploy-docker-ops.js";
import { BuildImageError } from "./github-deploy-docker-ops.js";
import type { RecordEventFn } from "./deployment-event-service.js";
import { SourceClientError, type SourceProviderClient } from "./source-provider.js";
import type { ResolvedGithubToken } from "./github-token-service.js";
import { cloneRepositoryBranch, cleanupCheckout, CloneError } from "./github-clone-service.js";
import { inspectCheckoutDirectory } from "./repository-inspection-service.js";
import { prepareBuildPlan, BuildPlanError } from "./build-strategy.js";
import { sanitizeProcessOutput } from "./process-runner.js";
import type { HealthCheckDependencies, HealthCheckHttpClient } from "./health-check-service.js";
import { performHealthCheck, sanitizeHealthCheckError } from "./health-check-service.js";

const PROTECTED_CONTAINER_NAMES = new Set([
  "deployment-platform-api",
  "deployment-platform-web"
]);

const DEFAULT_CLONE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_BUILD_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES = 256 * 1024;
const MAX_CONCURRENT_DEPLOYMENTS = 2;

/** Coarse, in-memory-only global throttle — not a correctness lock (that's the per-app DB lock below), just a resource guard against many builds running at once. */
let activeDeploymentCount = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const INTERNAL_CHECK_ATTEMPTS = 3;
const INTERNAL_CHECK_TIMEOUT_MS = 5000;
const INTERNAL_CHECK_RETRY_DELAY_MS = 1500;

export interface InternalCheckResult {
  reachable: boolean;
  statusCode: number | null;
  message: string;
}

/**
 * A bounded, retried HTTP request to the *replacement* container's own
 * name and configured port over the managed-app Docker network —
 * exactly the same request shape `health-check-service.ts` already
 * uses, reused here rather than reimplemented. The target is never
 * browser-supplied: `containerName` is the app's own validated
 * container name and `port` is the already-validated, saved
 * `containerPort` — nothing here is constructed from operator- or
 * request-supplied text. A connection failure (including "connection
 * refused" — nothing listening on that port) is treated as
 * unreachable; any actual HTTP response, even a 4xx/5xx from the app
 * itself, proves something is listening and is treated as reachable —
 * the *public* route check below is what gates on gateway-level
 * statuses like 502.
 */
export async function verifyInternalReachability(
  httpClient: HealthCheckHttpClient,
  containerName: string,
  port: number
): Promise<InternalCheckResult> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= INTERNAL_CHECK_ATTEMPTS; attempt += 1) {
    try {
      const result = await httpClient.request({
        hostname: containerName,
        port,
        path: "/",
        timeoutMs: INTERNAL_CHECK_TIMEOUT_MS
      });
      return {
        reachable: true,
        statusCode: result.statusCode,
        message: `Internal service responded with HTTP ${result.statusCode} on port ${port}.`
      };
    } catch (error) {
      lastError = sanitizeHealthCheckError(error);
      if (attempt < INTERNAL_CHECK_ATTEMPTS) {
        await sleep(INTERNAL_CHECK_RETRY_DELAY_MS);
      }
    }
  }

  return {
    reachable: false,
    statusCode: null,
    message: `Container started, but nothing responded on port ${port}${lastError ? ` (${lastError})` : "."}`
  };
}

const PUBLIC_CHECK_ATTEMPTS = 3;
const PUBLIC_CHECK_TIMEOUT_MS = 8000;
const PUBLIC_CHECK_RETRY_DELAY_MS = 2000;
/** Gateway/upstream-failure statuses — never "the deployment is fine, the app just returned an error page." */
const PUBLIC_CHECK_UNHEALTHY_STATUSES = new Set([502, 503, 504]);

export interface PublicCheckResult {
  ok: boolean;
  statusCode: number | null;
  message: string;
}

/**
 * Verifies the app's own platform-managed public domain — never an
 * operator- or browser-supplied URL; `domain` always comes from
 * `app.domain`, assigned by the platform itself when the app was
 * created. Bounded retries/timeout; 502/503/504, a connection failure,
 * or a TLS failure are all treated as deployment failure. Any other
 * response (including ordinary 4xx from the app itself) is accepted —
 * this is the platform's `502` bug fix, not a strict-uptime gate.
 */
export async function verifyPublicRoute(domain: string): Promise<PublicCheckResult> {
  const url = `https://${domain}/`;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= PUBLIC_CHECK_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_CHECK_TIMEOUT_MS);

    try {
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      clearTimeout(timer);

      if (PUBLIC_CHECK_UNHEALTHY_STATUSES.has(response.status)) {
        lastError = `HTTP ${response.status}`;
      } else {
        return { ok: true, statusCode: response.status, message: `Public route responded with HTTP ${response.status}.` };
      }
    } catch (error) {
      clearTimeout(timer);
      lastError = error instanceof Error ? error.message.slice(0, 300) : "Unknown network error";
    }

    if (attempt < PUBLIC_CHECK_ATTEMPTS) {
      await sleep(PUBLIC_CHECK_RETRY_DELAY_MS);
    }
  }

  return {
    ok: false,
    statusCode: null,
    message: `Public route did not return a healthy response${lastError ? ` (${lastError})` : "."}`
  };
}

export type DeployStage =
  | "resolving-repository"
  | "resolving-branch"
  | "reading-commit-metadata"
  | "preparing-checkout"
  | "cloning-repository"
  | "inspecting-project"
  | "preparing-build"
  | "building-image"
  | "preserving-current-container"
  | "starting-replacement"
  | "verifying-health"
  | "updating-route"
  | "cleaning-temporary-files"
  | "deployment-complete";

/**
 * Safe, structured diagnostics attached to a deploy-stage failure — the
 * same shape as CloneDiagnostics (from github-clone-service.ts), but not
 * imported directly since not every DeployStage failure originates from
 * a clone-related process; this keeps the field set generic enough for
 * any future stage that shells out to an external command.
 */
export interface DeployDiagnostics {
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  processStarted?: boolean;
  spawnErrorCode?: string;
  sanitizedStderrSummary?: string;
  sanitizedStdoutSummary?: string;
}

export class GithubDeployError extends Error {
  readonly stage: DeployStage;
  readonly diagnostics?: DeployDiagnostics;

  constructor(message: string, stage: DeployStage, diagnostics?: DeployDiagnostics) {
    super(message);
    this.name = "GithubDeployError";
    this.stage = stage;
    this.diagnostics = diagnostics;
  }
}

export interface GithubDeployResult {
  success: boolean;
  rolledBack: boolean;
  message: string;
  stage?: DeployStage;
  containerId?: string;
  imageTag?: string;
  commitSha?: string;
}

export interface GithubDeployDockerOps extends RedeployDockerOps, GithubBuildDockerOps {}

export interface GithubDeployDependencies {
  appDatabase: AppDatabase;
  dockerOps: GithubDeployDockerOps;
  githubClient: SourceProviderClient;
  resolveCredential: () => Promise<ResolvedGithubToken>;
  reconcileRouting: (appDatabase: AppDatabase) => Promise<{ lastReconcileSucceeded: boolean | null; lastError: string | null }>;
  recordEvent: RecordEventFn;
  /** Only constructed/used when the app actually has a health check configured. */
  healthCheckDeps?: Pick<HealthCheckDependencies, "httpClient" | "isContainerRunning" | "logger">;
  now?: () => Date;
  cloneTimeoutMs?: number;
  buildTimeoutMs?: number;
  maxLogBytes?: number;
  /** Test-only override for the `git` executable — see DEFAULT_GIT_EXECUTABLE in github-clone-service.ts. Never set in production. */
  gitExecutable?: string;
  /** Test-only override for the clone URL — see cloneUrlOverride in github-clone-service.ts. Never set in production. */
  cloneUrlOverride?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isLockfile(fileName: string): boolean {
  return (
    fileName === "package-lock.json" ||
    fileName === "npm-shrinkwrap.json" ||
    fileName === "pnpm-lock.yaml" ||
    fileName === "yarn.lock" ||
    fileName === "bun.lock" ||
    fileName === "bun.lockb"
  );
}

function sanitizeImageComponent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

function describeGithubClientError(error: unknown): string {
  if (error instanceof SourceClientError) {
    switch (error.kind) {
      case "invalid-token":
        return "GitHub token is invalid or expired.";
      case "insufficient-permissions":
        return "The connected GitHub token does not have permission to access this repository.";
      case "rate-limited":
        return "GitHub rate limit reached. Try again shortly.";
      case "not-found":
        return "Repository or branch could not be found.";
      case "network-timeout":
        return "Timed out while contacting GitHub.";
      default:
        return "Unable to reach GitHub right now.";
    }
  }
  return "Unable to reach GitHub right now.";
}

/**
 * Deploys an app from its configured GitHub source: resolves the branch
 * tip, clones it, inspects and builds it, then hands off to the same
 * "preserve the running container, swap, verify, roll back on failure"
 * shape as `redeployApp` — reusing `RedeployDockerOps` directly rather
 * than a second container-management implementation. Concurrency is
 * bounded per-app by a durable database lock (never two deployments for
 * the same app at once, even across a process restart) and globally by
 * an in-memory build-resource throttle.
 */
export async function deployFromGithub(
  deps: GithubDeployDependencies,
  appId: number,
  options: { expectedCommitSha?: string } = {}
): Promise<GithubDeployResult> {
  const { appDatabase, dockerOps, githubClient, resolveCredential, recordEvent } = deps;
  const now = deps.now ?? (() => new Date());
  const cloneTimeoutMs = deps.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  const buildTimeoutMs = deps.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const maxLogBytes = deps.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;

  const app = appDatabase.getAppById(appId);
  if (!app) {
    return { success: false, rolledBack: false, message: "App not found" };
  }

  if (!app.containerName || PROTECTED_CONTAINER_NAMES.has(app.containerName)) {
    return { success: false, rolledBack: false, message: "This app cannot be deployed from GitHub" };
  }

  const source = appDatabase.getAppSource(appId);
  if (!source) {
    return { success: false, rolledBack: false, message: "No GitHub source is configured for this app" };
  }

  if (!appDatabase.acquireDeploymentLock(appId)) {
    return {
      success: false,
      rolledBack: false,
      message: "A deployment for this app is already in progress"
    };
  }

  if (activeDeploymentCount >= MAX_CONCURRENT_DEPLOYMENTS) {
    appDatabase.releaseDeploymentLock(appId);
    return {
      success: false,
      rolledBack: false,
      message: "Too many GitHub deployments are running right now. Try again shortly."
    };
  }

  activeDeploymentCount += 1;

  recordEvent({
    appId,
    eventType: "github-deploy-started",
    severity: "info",
    message: `GitHub deployment started for "${app.name}" (${source.repositoryOwner}/${source.repositoryName}@${source.branch})`
  });

  function progress(stage: DeployStage, detail?: string) {
    recordEvent({
      appId,
      eventType: "github-deploy-progress",
      severity: "info",
      message: detail ? `${stageLabel(stage)}: ${detail}` : stageLabel(stage),
      metadata: { stage }
    });
  }

  let workDir: string | null = null;
  let rollbackContainerName: string | null = null;
  let replacementContainerId: string | null = null;
  /** Whatever name the replacement container currently sits under — the temp name until the swap rename succeeds, then the app's real container name. */
  let replacementCurrentName: string | null = null;
  let anySwapPerformed = false;
  /**
   * True only once the *previous* live container has been safely stopped and
   * renamed aside to rollbackContainerName — i.e. a real, verified rollback
   * copy exists. This is deliberately separate from anySwapPerformed: a first
   * deployment (or a recovery where the container is already missing) crosses
   * the swap boundary with NO previous container to preserve, and its failure
   * path must NOT masquerade as a rollback failure.
   */
  let previousContainerPreserved = false;
  /** Hoisted so the catch block can persist whatever these found even on a verification failure. */
  let internalCheckResult: InternalCheckResult | null = null;
  let publicCheckResult: PublicCheckResult | null = null;
  let selectedContainerPort: number | null = null;

  try {
    progress("resolving-repository");

    const credential = await resolveCredential();
    if (!credential.success) {
      throw new GithubDeployError("GitHub is not connected. Connect GitHub in Settings before deploying.", "resolving-repository");
    }

    progress("resolving-branch");

    let commitSha: string;
    try {
      commitSha = await githubClient.resolveBranchCommit(
        credential.token,
        source.repositoryOwner,
        source.repositoryName,
        source.branch
      );
    } catch (error) {
      throw new GithubDeployError(describeGithubClientError(error), "resolving-branch");
    }

    if (options.expectedCommitSha && options.expectedCommitSha !== commitSha) {
      throw new GithubDeployError(
        "The source configuration changed and requires reinspection before deploying.",
        "resolving-branch"
      );
    }

    progress("reading-commit-metadata");

    let commitMessage: string | null = null;
    try {
      const commits = await githubClient.listCommits(
        credential.token,
        source.repositoryOwner,
        source.repositoryName,
        source.branch,
        { perPage: 1, page: 1 }
      );
      commitMessage = commits.items[0]?.message ?? null;
    } catch {
      // Commit metadata is informational only — deployment can proceed
      // without it.
      commitMessage = null;
    }

    progress("preparing-checkout");

    const cloneResult = await cloneRepositoryBranch({
      repositoryOwner: source.repositoryOwner,
      repositoryName: source.repositoryName,
      branch: source.branch,
      token: credential.token,
      timeoutMs: cloneTimeoutMs,
      maxOutputBytes: maxLogBytes,
      gitExecutable: deps.gitExecutable,
      cloneUrlOverride: deps.cloneUrlOverride
    }).catch((error) => {
      if (error instanceof CloneError) {
        throw new GithubDeployError(error.message, error.stage as DeployStage, {
          exitCode: error.diagnostics.exitCode,
          signal: error.diagnostics.signal,
          timedOut: error.diagnostics.timedOut,
          aborted: error.diagnostics.aborted,
          processStarted: error.diagnostics.processStarted,
          spawnErrorCode: error.diagnostics.spawnErrorCode,
          sanitizedStderrSummary: error.diagnostics.sanitizedStderrSummary,
          sanitizedStdoutSummary: error.diagnostics.sanitizedStdoutSummary
        });
      }
      throw new GithubDeployError(errorMessage(error), "cloning-repository");
    });

    workDir = cloneResult.workDir;
    progress("cloning-repository", `checked out ${commitSha.slice(0, 12)}`);

    progress("inspecting-project");

    const detection = inspectCheckoutDirectory(cloneResult.checkoutDir, source.subdirectory);
    appDatabase.updateInspectionResult(appId, {
      buildStrategy: detection.recommendedStrategy,
      detectedProjectType: detection.detectedProjectType,
      latestRemoteCommitSha: commitSha
    });

    // Inspection recommendations are advisory, not mandatory: when the
    // operator has explicitly selected a strategy (source.selectedStrategy,
    // set via the Source tab / Create App wizard), THAT is what gets
    // built — never silently overridden by a fresh inspection's own
    // opinion, even if inspection recommends something else or considers
    // the repository "unsupported" by its own auto-detection heuristics.
    // With no explicit selection (the default, unchanged behavior),
    // deployment continues to follow detection.recommendedStrategy
    // exactly as before, including its "unsupported" gate.
    const effectiveStrategy = source.selectedStrategy ?? detection.recommendedStrategy;

    if (!source.selectedStrategy && !detection.supported) {
      throw new GithubDeployError(
        detection.unsupportedReason ?? "This repository's project type is not supported for deployment.",
        "inspecting-project"
      );
    }

    progress("preparing-build");

    const containerPort = source.containerPort ?? app.containerPort;
    selectedContainerPort = containerPort;
    const hasLockfile = detection.presentFiles.some(isLockfile);

    let buildPlan;
    try {
      buildPlan = prepareBuildPlan({
        strategy: effectiveStrategy,
        checkoutDir: cloneResult.checkoutDir,
        subdirectory: source.subdirectory,
        dockerfilePath: source.dockerfilePath,
        buildContext: source.buildContext,
        branch: source.branch,
        nodejs: detection.packageJson
          ? {
              packageManager: detection.packageJson.packageManager,
              hasLockfile,
              hasBuildScript: detection.packageJson.hasBuildScript,
              hasStartScript: detection.packageJson.hasStartScript,
              containerPort
            }
          : undefined
      });
    } catch (error) {
      if (error instanceof BuildPlanError) {
        throw new GithubDeployError(error.message, "preparing-build");
      }
      throw error;
    }

    progress("building-image");

    const shortSha = commitSha.slice(0, 12);
    const imageTag = `deployment-app-${appId}:${shortSha}`;
    const alreadyBuilt = await dockerOps.imageExists(imageTag);

    if (alreadyBuilt) {
      progress("building-image", `reusing existing image for commit ${shortSha} (already built)`);
      // No rebuild ran, so there's no fresh build output — record a short
      // note rather than leaving a stale prior log to look "current".
      appDatabase.updateBuildLog(appId, {
        log: `Reused the existing image for commit ${shortSha} — no rebuild was necessary.`,
        truncated: false,
        status: "reused",
        at: now().toISOString()
      });
    } else {
      try {
        const buildResult = await dockerOps.buildImage({
          contextPath: buildPlan.buildContextPath,
          dockerfileRelativePath: relative(buildPlan.buildContextPath, buildPlan.dockerfilePath),
          tag: imageTag,
          timeoutMs: buildTimeoutMs,
          maxLogBytes
        });

        // Persist the build output so the Logs tab can show it. Stored before
        // the container swap, so even a later rollback keeps the build record.
        appDatabase.updateBuildLog(appId, {
          log: buildResult.log,
          truncated: buildResult.truncated,
          status: "success",
          at: now().toISOString()
        });
      } catch (error) {
        if (error instanceof BuildImageError) {
          // A failed build's output is exactly what an operator needs to see.
          appDatabase.updateBuildLog(appId, {
            log: error.log,
            truncated: false,
            status: "failed",
            at: now().toISOString()
          });
          throw new GithubDeployError(
            `Build failed: ${sanitizeProcessOutput(error.message)}`,
            "building-image"
          );
        }
        throw new GithubDeployError(`Build failed: ${errorMessage(error)}`, "building-image");
      }
      progress("building-image", `built ${imageTag}`);
    }

    // Everything above this point only ever touched a scratch checkout
    // and, at most, created a *new* Docker image — the running
    // container has not been touched. From here on, a failure means
    // ROLLED_BACK once a swap has actually started, not FAILED.

    progress("preserving-current-container");

    const containerName = app.containerName;
    const exposedPort = `${containerPort}/tcp`;
    const tempContainerName = `${containerName}-github-deploy-${randomBytes(4).toString("hex")}`;
    rollbackContainerName = `${containerName}-rollback-${sanitizeImageComponent(now().toISOString())}`;

    const volumes = appDatabase.listAppVolumes(app.id);
    for (const volume of volumes) {
      await dockerOps.ensureVolume(volume.volumeName, app.name);
    }

    const portConfig = buildPublishedPortConfig(appDatabase.listAppPublishedPorts(app.id));

    const envArray = buildContainerEnvArray(appDatabase.listGlobalEnvVars(), appDatabase.listAppEnvVars(app.id));

    const created = await dockerOps.createContainer({
      name: tempContainerName,
      Image: imageTag,
      Env: envArray,
      Labels: {
        "com.deployment-platform.managed": "true",
        "com.deployment-platform.app-name": app.name
      },
      ExposedPorts: { [exposedPort]: {}, ...portConfig.ExposedPorts },
      HostConfig: {
        NetworkMode: "deployment-apps",
        RestartPolicy: { Name: app.restartPolicy || "unless-stopped" },
        Mounts: buildVolumeMounts(volumes),
        PortBindings: portConfig.PortBindings,
        ...buildResourceHostConfig(app)
        // Deliberately no Privileged, no CapAdd, no Binds against the
        // Docker socket or any host path — a repository's own
        // configuration can never request any of those.
      }
    });
    replacementContainerId = created.id;
    replacementCurrentName = tempContainerName;

    progress("starting-replacement");
    await dockerOps.startContainer(replacementContainerId);

    const inspected = await dockerOps.inspectContainer(replacementContainerId);
    if (!inspected.running) {
      throw new GithubDeployError(
        `New container failed to reach a running state (status: ${inspected.status})`,
        "starting-replacement"
      );
    }

    // Preserve-then-swap. Everything up to here left the live container
    // completely untouched (the replacement is running under a temp name).
    // Now, and only now, do we move the live container out of the way —
    // and we do it by PRESERVING it (stop + rename to the rollback name),
    // never by deleting it. The old container is destroyed only after the
    // replacement is fully verified below, so a rollback always has a real
    // container to restore.
    const previousExists = await dockerOps.containerExists(containerName);
    if (previousExists) {
      // Stop first (safe, idempotent), then rename aside. If the rename
      // itself fails we have not yet crossed the swap boundary, so restart
      // the previous container and fail as a clean pre-swap error — the
      // live app is left exactly as it was.
      await dockerOps.stopContainer(containerName).catch(() => undefined);
      try {
        await dockerOps.renameContainer(containerName, rollbackContainerName);
        previousContainerPreserved = true;
      } catch (preserveError) {
        await dockerOps.startContainer(containerName).catch(() => undefined);
        throw new GithubDeployError(
          `Could not preserve the current container before swapping: ${errorMessage(preserveError)}`,
          "preserving-current-container"
        );
      }
    }
    // Case B/C: no previous container exists (a first deployment, or a
    // recovery where the runtime went missing). There is nothing to
    // preserve — the live name is simply free to take over.

    // Swap boundary: the live name is now free. Take it over with the
    // replacement. From here a failure means the app is temporarily down
    // and must be restored (if a previous version was preserved) or
    // reported as a recoverable first-deploy failure (if not).
    anySwapPerformed = true;
    await dockerOps.renameContainer(replacementContainerId, containerName);
    replacementCurrentName = containerName;

    progress("verifying-health");

    // Mandatory, unconditional internal reachability check — independent
    // of whether the app happens to have an optional health-check row
    // configured. A GitHub deployment must never be recorded successful
    // just because "the container reached a running state"; the
    // application inside it must actually be listening on the
    // configured port. This is the direct fix for the reported bug: a
    // container that started fine but had nothing listening on the
    // (wrong) configured port was previously recorded as a success.
    if (!deps.healthCheckDeps) {
      throw new GithubDeployError(
        "Internal verification is not configured for this deployment pipeline.",
        "verifying-health"
      );
    }

    internalCheckResult = await verifyInternalReachability(deps.healthCheckDeps.httpClient, containerName, containerPort);

    recordEvent({
      appId,
      eventType: "github-deploy-progress",
      severity: internalCheckResult.reachable ? "info" : "error",
      message: `Verifying internal application port: ${internalCheckResult.message}`,
      metadata: {
        stage: "verifying-health",
        configuredPort: containerPort,
        internalStatusCode: internalCheckResult.statusCode,
        internalReachable: internalCheckResult.reachable
      }
    });

    if (!internalCheckResult.reachable) {
      throw new GithubDeployError(internalCheckResult.message, "verifying-health");
    }

    if (app.domain) {
      publicCheckResult = await verifyPublicRoute(app.domain);

      recordEvent({
        appId,
        eventType: "github-deploy-progress",
        severity: publicCheckResult.ok ? "info" : "error",
        message: `Verifying public route: ${publicCheckResult.message}`,
        metadata: {
          stage: "verifying-health",
          publicStatusCode: publicCheckResult.statusCode,
          publicReachable: publicCheckResult.ok
        }
      });

      if (!publicCheckResult.ok) {
        throw new GithubDeployError(
          `Internal service responded on port ${containerPort}, but the public route returned an error: ${publicCheckResult.message}`,
          "verifying-health"
        );
      }
    }

    // An operator-configured health check, if one exists, still runs too
    // — additively, never as a substitute for the mandatory checks above.
    const healthConfig = appDatabase.getAppHealthCheck(appId);
    if (healthConfig) {
      const healthOutcome = await performHealthCheck(
        {
          appDatabase,
          httpClient: deps.healthCheckDeps.httpClient,
          isContainerRunning: deps.healthCheckDeps.isContainerRunning,
          recordEvent,
          logger: deps.healthCheckDeps.logger,
          now
        },
        appId
      );

      if (healthOutcome.state === "unhealthy" || healthOutcome.state === "error") {
        throw new GithubDeployError(
          `Health verification failed after deployment${healthOutcome.errorMessage ? `: ${healthOutcome.errorMessage}` : "."}`,
          "verifying-health"
        );
      }
    }

    // Only now — after every required verification has passed — is the
    // deployment allowed to update deployed-commit bookkeeping.
    appDatabase.updateDeploymentHealthResult(appId, {
      lastInternalHealthResult: internalCheckResult.message,
      lastPublicHealthResult: publicCheckResult ? publicCheckResult.message : null,
      lastDeploymentStatus: "PASS"
    });

    const finalInspection = await dockerOps.inspectContainer(replacementContainerId);
    appDatabase.updateAppContainer(app.id, {
      containerId: finalInspection.id,
      status: finalInspection.status
    });

    appDatabase.updateDeployedCommit(appId, {
      commitSha,
      commitMessage,
      deployedAt: now().toISOString()
    });

    // Append this release to the per-app version ledger. The image
    // (`deployment-app-<id>:<shortSha>`) is retained locally, so this row
    // is a revertable target for future deployments.
    appDatabase.recordDeployment({
      appId,
      imageTag,
      commitSha,
      commitMessage,
      sourceKind: "github"
    });

    progress("updating-route");
    let routingWarning: string | null = null;
    try {
      const routingStatus = await deps.reconcileRouting(appDatabase);
      if (routingStatus.lastReconcileSucceeded === false) {
        routingWarning = routingStatus.lastError ?? "unknown routing error";
      }
    } catch (error) {
      routingWarning = errorMessage(error);
    }

    // Verified success: the replacement is live, healthy, and both the
    // database and routing now point at it. Only now is it safe to remove
    // the preserved previous container — never before this point, so a
    // failure at any earlier step could always roll back to it. Best-effort:
    // a leftover rollback container is untidy but not a deployment failure.
    if (previousContainerPreserved && rollbackContainerName) {
      await dockerOps.removeContainer(rollbackContainerName).catch(() => undefined);
    }

    progress("cleaning-temporary-files");
    cleanupCheckout(cloneResult.workDir);
    workDir = null;

    recordEvent({
      appId,
      eventType: "github-deploy-succeeded",
      severity: "info",
      message: `GitHub deployment succeeded for "${app.name}" at commit ${shortSha}`,
      metadata: { commitShortSha: shortSha, imageTag }
    });

    if (routingWarning) {
      recordEvent({
        appId,
        eventType: "routing-warning",
        severity: "warning",
        message: `Routing warning after deploying "${app.name}" from GitHub: ${routingWarning}`
      });
    }

    return {
      success: true,
      rolledBack: false,
      message: "Deployment succeeded.",
      containerId: finalInspection.id,
      imageTag,
      commitSha
    };
  } catch (error) {
    const stage = error instanceof GithubDeployError ? error.stage : "deployment-complete";
    const message = error instanceof GithubDeployError ? error.message : errorMessage(error);
    const diagnostics = error instanceof GithubDeployError ? error.diagnostics : undefined;

    // Flat, primitive-only metadata — matches what deployment-event-
    // service.ts's sanitizeMetadata expects and additionally defends
    // against (it drops anything else, caps string length, and rejects
    // secret-looking keys — this is deliberately never anything more than
    // stage/exit-code/signal-shaped facts, never raw process output).
    const eventMetadata: Record<string, unknown> = { stage };
    if (selectedContainerPort !== null) {
      eventMetadata.configuredPort = selectedContainerPort;
    }
    if (internalCheckResult) {
      eventMetadata.internalStatusCode = internalCheckResult.statusCode;
      eventMetadata.internalReachable = internalCheckResult.reachable;
    }
    if (publicCheckResult) {
      eventMetadata.publicStatusCode = publicCheckResult.statusCode;
      eventMetadata.publicReachable = publicCheckResult.ok;
    }
    if (diagnostics) {
      if (diagnostics.exitCode !== undefined) eventMetadata.exitCode = diagnostics.exitCode;
      if (diagnostics.signal !== undefined) eventMetadata.signal = diagnostics.signal;
      if (diagnostics.timedOut !== undefined) eventMetadata.timedOut = diagnostics.timedOut;
      if (diagnostics.aborted !== undefined) eventMetadata.aborted = diagnostics.aborted;
      if (diagnostics.processStarted !== undefined) eventMetadata.processStarted = diagnostics.processStarted;
      if (diagnostics.spawnErrorCode !== undefined) eventMetadata.spawnErrorCode = diagnostics.spawnErrorCode;
      if (diagnostics.sanitizedStderrSummary !== undefined) {
        eventMetadata.stderrSummary = diagnostics.sanitizedStderrSummary;
      }
      if (diagnostics.sanitizedStdoutSummary !== undefined) {
        eventMetadata.stdoutSummary = diagnostics.sanitizedStdoutSummary;
      }
    }

    if (!anySwapPerformed) {
      // Nothing live was ever touched — clean up any replacement
      // container we may have created/started but never swapped in.
      if (replacementContainerId) {
        await dockerOps.removeContainer(replacementContainerId).catch(() => undefined);
      }

      recordEvent({
        appId,
        eventType: "github-deploy-failed",
        severity: "error",
        message: `GitHub deployment failed for "${app.name}" (stage: ${stage}): ${message}`,
        metadata: eventMetadata
      });

      appDatabase.updateDeploymentHealthResult(appId, {
        lastInternalHealthResult: internalCheckResult?.message ?? null,
        lastPublicHealthResult: publicCheckResult?.message ?? null,
        lastDeploymentStatus: "FAILED"
      });

      return { success: false, rolledBack: false, message, stage };
    }

    // The swap boundary was crossed but the deployment failed. Always
    // remove the failed replacement first — it is not a viable app.
    if (replacementCurrentName) {
      await dockerOps.removeContainer(replacementCurrentName).catch(() => undefined);
    }

    if (!previousContainerPreserved) {
      // Case B/C: there was no previous container to preserve (a first
      // deployment, or a recovery of an app whose runtime had gone
      // missing). There is nothing to "roll back" TO — so this is a plain,
      // recoverable FAILED, never a fake ROLLBACK_FAILED. The app's
      // database record is deliberately left intact so it stays visible on
      // the Apps page and can simply be redeployed.
      recordEvent({
        appId,
        eventType: "github-deploy-failed",
        severity: "error",
        message: `GitHub deployment failed for "${app.name}" (stage: ${stage}): ${message}. No previous container existed, so there was nothing to roll back — the app has no running container and can be redeployed.`,
        metadata: eventMetadata
      });

      // The runtime is gone — reflect that in the app record rather than
      // leaving a stale "running" status that no live container backs. The
      // Apps list/detail also cross-check live Docker state, so display is
      // never driven by this value alone.
      appDatabase.updateAppStatus(app.id, "missing");
      appDatabase.updateDeploymentHealthResult(appId, {
        lastInternalHealthResult: internalCheckResult?.message ?? null,
        lastPublicHealthResult: publicCheckResult?.message ?? null,
        lastDeploymentStatus: "FAILED"
      });

      return { success: false, rolledBack: false, message, stage };
    }

    // Case A: a previous container was preserved (stopped + renamed aside).
    // Restore it from its rollback name and bring it back up.
    let restored = false;
    let restoreError: string | null = null;

    try {
      if (rollbackContainerName) {
        await dockerOps.renameContainer(rollbackContainerName, app.containerName as string);
        await dockerOps.startContainer(app.containerName as string);
        const restoredInspection = await dockerOps.inspectContainer(app.containerName as string);
        restored = restoredInspection.running;
        if (restored) {
          appDatabase.updateAppContainer(app.id, {
            containerId: restoredInspection.id,
            status: restoredInspection.status
          });
        }
      }
    } catch (restoreErr) {
      restoreError = errorMessage(restoreErr);
    }

    recordEvent({
      appId,
      eventType: "github-deploy-rolled-back",
      severity: "error",
      message: restored
        ? `GitHub deployment for "${app.name}" failed at stage "${stage}" (${message}); the previous version was restored.`
        : `GitHub deployment for "${app.name}" failed at stage "${stage}" (${message}); automatic rollback ALSO failed${restoreError ? `: ${restoreError}` : ""}. Manual attention required.`,
      metadata: { ...eventMetadata, rolledBack: restored }
    });

    // Never update latest_deployed_commit_sha/latest_deployed_at on a
    // rollback (see updateDeployedCommit above, never reached on this
    // path) — but do record what the health checks actually found, and
    // the exact distinct status, so the Source tab reflects reality
    // rather than the last time a deployment *succeeded*.
    appDatabase.updateDeploymentHealthResult(appId, {
      lastInternalHealthResult: internalCheckResult?.message ?? null,
      lastPublicHealthResult: publicCheckResult?.message ?? null,
      lastDeploymentStatus: restored ? "ROLLED_BACK" : "ROLLBACK_FAILED"
    });

    return {
      success: false,
      rolledBack: restored,
      message: restored
        ? `Deployment failed and the previous version was restored. (${message})`
        : `Deployment failed and automatic rollback also failed — manual attention required. (${message})`,
      stage
    };
  } finally {
    if (workDir) {
      cleanupCheckout(workDir);
    }
    appDatabase.releaseDeploymentLock(appId);
    activeDeploymentCount = Math.max(0, activeDeploymentCount - 1);
  }
}

function stageLabel(stage: DeployStage): string {
  switch (stage) {
    case "resolving-repository":
      return "Resolving repository";
    case "resolving-branch":
      return "Resolving branch";
    case "reading-commit-metadata":
      return "Reading commit metadata";
    case "preparing-checkout":
      return "Preparing checkout";
    case "cloning-repository":
      return "Cloning repository";
    case "inspecting-project":
      return "Inspecting project";
    case "preparing-build":
      return "Preparing build";
    case "building-image":
      return "Building image";
    case "preserving-current-container":
      return "Preserving current container";
    case "starting-replacement":
      return "Starting replacement";
    case "verifying-health":
      return "Verifying health";
    case "updating-route":
      return "Updating route";
    case "cleaning-temporary-files":
      return "Cleaning temporary files";
    case "deployment-complete":
    default:
      return "Deployment complete";
  }
}
