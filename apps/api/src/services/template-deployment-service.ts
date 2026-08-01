import type {
  CreateAppServiceResult,
  CreateAppWithConfigInput,
  CreatedAppSummary
} from "./app-creation-service.js";

/**
 * Multi-service template deployment.
 *
 * A template like Blueprint needs more than one container (a chat interface
 * plus a private model server). Rather than inventing a second deployment
 * system, each companion is created as a NORMAL managed app through the very
 * same createAppWithConfig() path the wizard already uses — so every
 * companion gets the platform's ordinary routing decision, volumes, health,
 * backups, image-update checks, Delete button, and cleanup rules for free.
 *
 * All this module adds on top is ordering and failure handling:
 *   - companions are created FIRST, so the main app can reach them on its
 *     very first boot rather than crash-looping until they appear;
 *   - if any step fails, everything this call already created is removed
 *     again, so a partial install never leaves stray containers, volumes,
 *     or app records behind.
 */

/** One companion service to create before the main app. */
export interface TemplateCompanionInput {
  name: string;
  image: string;
  containerPort: number;
  restartPolicy?: string;
  internalOnly?: boolean;
  environmentVariables?: CreateAppWithConfigInput["environmentVariables"];
  storageMounts?: CreateAppWithConfigInput["storageMounts"];
}

export interface DeployTemplateStackInput {
  /** The template's main, usually publicly routed, app. */
  main: CreateAppWithConfigInput;
  /** Backing services, created in order before `main`. */
  companions: TemplateCompanionInput[];
}

export interface TemplateStackRollbackReport {
  /** Apps this call created and then tried to remove again. */
  attempted: number;
  /** How many were actually removed. */
  removed: number;
  /** Names of apps that could not be removed and need manual cleanup. */
  leftover: string[];
}

export interface DeployTemplateStackResult {
  success: boolean;
  statusCode?: number;
  message: string;
  /** The main app, on success. */
  app?: CreatedAppSummary;
  /** The companions created, on success. */
  companions?: CreatedAppSummary[];
  /** Present only on failure, describing what was cleaned up. */
  rollback?: TemplateStackRollbackReport;
}

export interface DeployTemplateStackDependencies {
  /** The single authoritative app-creation path (app-creation-service). */
  createApp: (input: CreateAppWithConfigInput) => Promise<CreateAppServiceResult>;
  /**
   * Removes an app this call created, for rollback. Resolves true when the
   * app is gone. Must never throw — a rollback failure is reported, never
   * allowed to mask the original error.
   */
  removeApp: (appId: number) => Promise<boolean>;
  /**
   * Declares every service this install will create, in creation order, so
   * a progress bar knows its denominator before any work begins rather than
   * growing it as services appear. Optional — callers that don't report
   * progress simply omit it.
   */
  beginProgress?: (serviceNames: string[]) => void;
}

/**
 * A stable per-companion idempotency key derived from the caller's key for
 * the overall attempt. Without this, a transport-level retry of one request
 * would replay the main app (which has the caller's key) but re-run every
 * companion as a brand-new create, colliding on the companion's app name.
 * Deriving instead of sharing also keeps each companion's cached result
 * distinct — the same key must never map to two different request bodies.
 */
export function companionIdempotencyKey(
  baseKey: string,
  companionName: string
): string {
  return `${baseKey}:companion:${companionName}`;
}

/**
 * Creates every companion, then the main app. Any failure rolls back
 * everything this call created, in reverse order, and reports both the
 * original error and what cleanup achieved.
 */
export async function deployTemplateStack(
  deps: DeployTemplateStackDependencies,
  input: DeployTemplateStackInput
): Promise<DeployTemplateStackResult> {
  const { createApp, removeApp, beginProgress } = deps;
  const created: CreatedAppSummary[] = [];

  // Companions first, then the main app — the same order they're created in
  // below, so the bar advances left to right through the list it showed.
  beginProgress?.([
    ...input.companions.map((companion) => companion.name),
    input.main.name
  ]);

  const rollback = async (): Promise<TemplateStackRollbackReport> => {
    const leftover: string[] = [];
    let removed = 0;

    // Reverse order: the main app (if it exists) depends on the
    // companions, so it goes first, mirroring creation order.
    for (const app of [...created].reverse()) {
      let ok = false;
      try {
        ok = await removeApp(app.id);
      } catch {
        ok = false;
      }

      if (ok) {
        removed += 1;
      } else {
        leftover.push(app.name);
      }
    }

    return { attempted: created.length, removed, leftover };
  };

  const fail = async (
    message: string,
    statusCode: number
  ): Promise<DeployTemplateStackResult> => {
    const report = await rollback();

    const cleanupNote =
      report.attempted === 0
        ? ""
        : report.leftover.length > 0
          ? ` Cleanup removed ${report.removed} of ${report.attempted} already-created app(s); ${report.leftover.join(", ")} could not be removed and need manual cleanup.`
          : ` The ${report.removed} app(s) already created were removed again.`;

    return {
      success: false,
      statusCode,
      message: `${message}${cleanupNote}`,
      rollback: report
    };
  };

  for (const companion of input.companions) {
    const baseKey = input.main.idempotencyKey;

    let result: CreateAppServiceResult;
    try {
      result = await createApp({
        name: companion.name,
        image: companion.image,
        containerPort: companion.containerPort,
        restartPolicy: companion.restartPolicy,
        environmentVariables: companion.environmentVariables ?? [],
        storageMounts: companion.storageMounts ?? [],
        // A backing service never publishes a host port, and defaults to
        // having no public domain at all.
        publishedPorts: [],
        internalOnly: companion.internalOnly ?? true,
        ...(baseKey
          ? { idempotencyKey: companionIdempotencyKey(baseKey, companion.name) }
          : {})
      });
    } catch (error) {
      return fail(
        `Unable to create the "${companion.name}" service: ${
          error instanceof Error ? error.message : String(error)
        }.`,
        502
      );
    }

    if (!result.success || !result.app) {
      return fail(
        `Unable to create the "${companion.name}" service: ${result.message}`,
        result.statusCode ?? 502
      );
    }

    created.push(result.app);
  }

  let mainResult: CreateAppServiceResult;
  try {
    mainResult = await createApp(input.main);
  } catch (error) {
    return fail(
      `Unable to create "${input.main.name}": ${
        error instanceof Error ? error.message : String(error)
      }.`,
      502
    );
  }

  if (!mainResult.success || !mainResult.app) {
    return fail(
      `Unable to create "${input.main.name}": ${mainResult.message}`,
      mainResult.statusCode ?? 502
    );
  }

  return {
    success: true,
    message: mainResult.message,
    app: mainResult.app,
    companions: created
  };
}
