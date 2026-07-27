import type { AppDatabase, StoredAppSource } from "../database.js";
import type { RecordEventFn } from "./deployment-event-service.js";
import { SourceClientError, type SourceProviderClient } from "./source-provider.js";
import type { AppSourceConfigInput } from "../schemas/source.js";
import type { CredentialStatus, DecryptedTokenResult } from "./github-credential-service.js";

type AppSourceDatabase = Pick<
  AppDatabase,
  | "getAppById"
  | "getAppSource"
  | "upsertAppSource"
  | "updateAppSourceValidation"
  | "deleteAppSource"
>;

export interface AppSourceLogger {
  error: (obj: unknown, message?: string) => void;
}

export interface AppSourceServiceDeps {
  appDatabase: AppSourceDatabase;
  githubClient: SourceProviderClient;
  /** Never returns the token itself to a caller outside this service. */
  resolveCredential: () => DecryptedTokenResult;
  recordEvent: RecordEventFn;
  logger: AppSourceLogger;
  now?: () => Date;
}

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

function safeClientMessage(error: unknown): string {
  if (error instanceof SourceClientError) {
    return error.message;
  }

  return "Unable to reach GitHub right now.";
}

function describeCredentialUnavailable(status: CredentialStatus): string {
  switch (status) {
    case "not-configured":
      return "GitHub is not connected. Connect GitHub in Settings before linking a repository.";
    case "encryption-key-missing":
    case "encryption-key-invalid":
      return "GitHub credentials cannot be used right now because of a server configuration problem. Contact the operator.";
    case "credential-unavailable":
      return "The stored GitHub credential can no longer be used. Reconnect GitHub in Settings.";
    default:
      return "GitHub is not available right now.";
  }
}

export interface AppSourceValidationResult {
  status: "valid" | "invalid";
  error: string | null;
  commitSha: string | null;
  repositoryVisibility: "public" | "private" | null;
  repositoryId: string | null;
}

/**
 * The one implementation of "check whether a source configuration is
 * actually usable" — both saving a new/changed configuration and the
 * explicit "Validate Again" action call this directly, so there is no
 * second copy of the repository/branch/Dockerfile checks to drift apart.
 * Never clones, downloads, or stores repository content — only existence
 * and metadata checks against the GitHub API.
 */
export async function validateAppSource(
  deps: Pick<AppSourceServiceDeps, "githubClient" | "resolveCredential">,
  source: Pick<StoredAppSource, "repositoryOwner" | "repositoryName" | "branch" | "deploymentMode" | "dockerfilePath">
): Promise<AppSourceValidationResult> {
  const credential = deps.resolveCredential();

  if (!credential.success) {
    return {
      status: "invalid",
      error: describeCredentialUnavailable(credential.credentialStatus),
      commitSha: null,
      repositoryVisibility: null,
      repositoryId: null
    };
  }

  let repositoryVisibility: "public" | "private" | null = null;
  let repositoryId: string | null = null;

  try {
    const repository = await deps.githubClient.getRepository(
      credential.token,
      source.repositoryOwner,
      source.repositoryName
    );
    repositoryVisibility = repository.private ? "private" : "public";
    repositoryId = repository.id;
  } catch (error) {
    return {
      status: "invalid",
      error: safeClientMessage(error),
      commitSha: null,
      repositoryVisibility: null,
      repositoryId: null
    };
  }

  let commitSha: string;

  try {
    commitSha = await deps.githubClient.resolveBranchCommit(
      credential.token,
      source.repositoryOwner,
      source.repositoryName,
      source.branch
    );
  } catch (error) {
    return {
      status: "invalid",
      error: safeClientMessage(error),
      commitSha: null,
      repositoryVisibility,
      repositoryId
    };
  }

  if (source.deploymentMode === "dockerfile") {
    let exists: boolean;

    try {
      exists = await deps.githubClient.pathExists(
        credential.token,
        source.repositoryOwner,
        source.repositoryName,
        commitSha,
        source.dockerfilePath
      );
    } catch (error) {
      return {
        status: "invalid",
        error: safeClientMessage(error),
        commitSha,
        repositoryVisibility,
        repositoryId
      };
    }

    if (!exists) {
      return {
        status: "invalid",
        error: `Dockerfile not found at "${source.dockerfilePath}" on branch "${source.branch}"`,
        commitSha,
        repositoryVisibility,
        repositoryId
      };
    }
  }

  return { status: "valid", error: null, commitSha, repositoryVisibility, repositoryId };
}

export interface AppSourceResult {
  success: boolean;
  statusCode?: number;
  message?: string;
  source?: StoredAppSource;
}

/**
 * Persists a new or replaced source link, then immediately validates it —
 * the config is saved either way (so an operator can see and fix a
 * failing link rather than having it silently rejected), but the
 * validation outcome is always recorded alongside it.
 */
export async function saveAppSource(
  deps: AppSourceServiceDeps,
  appId: number,
  input: AppSourceConfigInput
): Promise<AppSourceResult> {
  const app = deps.appDatabase.getAppById(appId);

  if (!app) {
    return { success: false, statusCode: 404, message: "App not found" };
  }

  const existing = deps.appDatabase.getAppSource(appId);

  deps.appDatabase.upsertAppSource(appId, {
    provider: "github",
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    // GitHub's full name and HTTPS clone URL are both deterministic from
    // owner/name — no extra API call needed to derive them.
    repositoryFullName: `${input.repositoryOwner}/${input.repositoryName}`,
    repositoryCloneUrl: `https://github.com/${input.repositoryOwner}/${input.repositoryName}.git`,
    repositoryId: null,
    repositoryVisibility: null,
    branch: input.branch,
    subdirectory: input.subdirectory,
    deploymentMode: input.deploymentMode,
    dockerfilePath: input.dockerfilePath,
    buildContext: input.buildContext,
    containerPort: input.containerPort ?? null,
    containerPortSource: input.containerPortSource ?? null,
    containerPortConfidence: input.containerPortConfidence ?? null,
    autoDeploy: input.autoDeploy
  });

  const nowIso = (deps.now ?? (() => new Date()))().toISOString();

  let validation: AppSourceValidationResult;

  try {
    validation = await validateAppSource(deps, {
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      branch: input.branch,
      deploymentMode: input.deploymentMode,
      dockerfilePath: input.dockerfilePath
    });
  } catch (error) {
    // validateAppSource is designed to never throw — this is a last-resort
    // guard so a truly unexpected failure still leaves a readable status
    // on the row instead of an uncaught rejection.
    deps.logger.error({ appId, error: error instanceof Error ? error.message : "Unknown error" }, "Unexpected source validation failure");
    validation = {
      status: "invalid",
      error: "Validation failed unexpectedly.",
      commitSha: null,
      repositoryVisibility: null,
      repositoryId: null
    };
  }

  deps.appDatabase.updateAppSourceValidation(appId, {
    validationStatus: validation.status,
    validationError: validation.error,
    lastValidatedCommitSha: validation.commitSha,
    lastValidatedAt: nowIso,
    repositoryVisibility: validation.repositoryVisibility,
    repositoryId: validation.repositoryId
  });

  const linkMetadata = {
    provider: "github",
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    branch: input.branch,
    deploymentMode: input.deploymentMode
  };

  deps.recordEvent({
    appId,
    eventType: existing ? "source-updated" : "source-linked",
    severity: "info",
    message: existing
      ? `${app.name}: source updated to ${input.repositoryOwner}/${input.repositoryName}@${input.branch}`
      : `${app.name}: linked to ${input.repositoryOwner}/${input.repositoryName}@${input.branch}`,
    metadata: linkMetadata
  });

  deps.recordEvent({
    appId,
    eventType: validation.status === "valid" ? "source-validation-succeeded" : "source-validation-failed",
    severity: validation.status === "valid" ? "info" : "warning",
    message:
      validation.status === "valid"
        ? `${app.name}: source validation succeeded`
        : `${app.name}: source validation failed`,
    metadata: {
      ...linkMetadata,
      shortSha: shortSha(validation.commitSha),
      validationStatus: validation.status
    }
  });

  return { success: true, source: deps.appDatabase.getAppSource(appId) ?? undefined };
}

/** Re-runs validation for the currently-saved configuration without changing it. */
export async function revalidateAppSource(deps: AppSourceServiceDeps, appId: number): Promise<AppSourceResult> {
  const app = deps.appDatabase.getAppById(appId);

  if (!app) {
    return { success: false, statusCode: 404, message: "App not found" };
  }

  const source = deps.appDatabase.getAppSource(appId);

  if (!source) {
    return { success: false, statusCode: 404, message: "No source is linked to this app" };
  }

  const validation = await validateAppSource(deps, source);
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();

  deps.appDatabase.updateAppSourceValidation(appId, {
    validationStatus: validation.status,
    validationError: validation.error,
    lastValidatedCommitSha: validation.commitSha,
    lastValidatedAt: nowIso,
    repositoryVisibility: validation.repositoryVisibility,
    repositoryId: validation.repositoryId
  });

  deps.recordEvent({
    appId,
    eventType: validation.status === "valid" ? "source-validation-succeeded" : "source-validation-failed",
    severity: validation.status === "valid" ? "info" : "warning",
    message:
      validation.status === "valid"
        ? `${app.name}: source validation succeeded`
        : `${app.name}: source validation failed`,
    metadata: {
      provider: "github",
      repositoryOwner: source.repositoryOwner,
      repositoryName: source.repositoryName,
      branch: source.branch,
      shortSha: shortSha(validation.commitSha),
      validationStatus: validation.status
    }
  });

  return { success: true, source: deps.appDatabase.getAppSource(appId) ?? undefined };
}

export function removeAppSource(deps: AppSourceServiceDeps, appId: number): AppSourceResult {
  const app = deps.appDatabase.getAppById(appId);

  if (!app) {
    return { success: false, statusCode: 404, message: "App not found" };
  }

  const existing = deps.appDatabase.getAppSource(appId);

  if (!existing) {
    return { success: false, statusCode: 404, message: "No source is linked to this app" };
  }

  deps.appDatabase.deleteAppSource(appId);

  deps.recordEvent({
    appId,
    eventType: "source-removed",
    severity: "info",
    message: `${app.name}: source link to ${existing.repositoryOwner}/${existing.repositoryName} removed`,
    metadata: {
      provider: "github",
      repositoryOwner: existing.repositoryOwner,
      repositoryName: existing.repositoryName,
      branch: existing.branch
    }
  });

  return { success: true };
}
