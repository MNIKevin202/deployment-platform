import type { AppDatabase } from "../database.js";
import { resolveAppDomainChoice } from "../domain.js";
import type { RedeployReconcileResult } from "./redeploy-service.js";
import type { RecordEventFn } from "./deployment-event-service.js";

/**
 * Container names the platform itself runs under — never a managed app's
 * container, so a routing change can never be pointed at (or claim to
 * govern) the platform's own API/web/Caddy containers. Mirrors
 * redeploy-service.ts's PROTECTED_CONTAINER_NAMES; kept as its own local
 * copy rather than a shared import so this module's safety check does not
 * depend on redeploy-service.ts's unrelated redeploy-specific exports.
 */
const RESERVED_CONTAINER_NAMES = new Set([
  "deployment-platform-api",
  "deployment-platform-web",
  "deployment-platform-caddy"
]);

export interface UpdateAppRoutingInput {
  internalOnly: boolean;
  customDomain?: string;
}

export interface UpdateAppRoutingResult {
  success: boolean;
  statusCode?: number;
  message: string;
  domain?: string | null;
  internalOnly?: boolean;
}

export interface UpdateAppRoutingDependencies {
  appDatabase: AppDatabase;
  reconcileRouting: (appDatabase: AppDatabase) => Promise<RedeployReconcileResult>;
  recordEvent: RecordEventFn;
  /** Injected for tests; production always uses buildAppDomain (the default in resolveAppDomainChoice). */
  buildDomain?: (name: string) => string;
}

/**
 * Toggles an app between public (generated default domain, or a validated
 * custom domain) and internal-only (no domain, never routed), or changes a
 * public app's domain — the single place this happens, so create and
 * update always apply the exact same policy (resolveAppDomainChoice) and
 * the exact same uniqueness/reserved-container checks.
 *
 * Container and volumes are never touched here — only `apps.domain` and
 * `apps.internal_only`, plus a best-effort Caddy reconciliation. A
 * reconciliation failure does not roll back the domain change (the stored
 * choice is still correct and will apply on the next successful
 * reconcile), matching how app creation and redeploy already treat routing
 * as best-effort relative to the underlying resource change.
 */
export async function updateAppRouting(
  deps: UpdateAppRoutingDependencies,
  appId: number,
  input: UpdateAppRoutingInput
): Promise<UpdateAppRoutingResult> {
  const { appDatabase, reconcileRouting, recordEvent, buildDomain } = deps;

  const app = appDatabase.getAppById(appId);

  if (!app) {
    return { success: false, statusCode: 404, message: "App not found" };
  }

  if (app.containerName && RESERVED_CONTAINER_NAMES.has(app.containerName)) {
    return {
      success: false,
      statusCode: 400,
      message: "This app's routing cannot be changed through this endpoint"
    };
  }

  const choice = buildDomain
    ? resolveAppDomainChoice(app.name, input, process.env, buildDomain)
    : resolveAppDomainChoice(app.name, input, process.env);

  if (!choice.ok) {
    return { success: false, statusCode: choice.statusCode, message: choice.error };
  }

  if (choice.domain) {
    const existing = appDatabase.getAppByDomain(choice.domain);
    if (existing && existing.id !== app.id) {
      return {
        success: false,
        statusCode: 409,
        message: `Domain "${choice.domain}" is already assigned to another app`
      };
    }
  }

  const previousDomain = app.domain;
  const previousInternalOnly = app.internalOnly;

  appDatabase.updateAppRouting(app.id, {
    domain: choice.domain,
    internalOnly: choice.internalOnly
  });

  let routingWarning: string | null = null;

  try {
    const routingStatus = await reconcileRouting(appDatabase);
    if (routingStatus.lastReconcileSucceeded === false) {
      routingWarning = `routing could not be updated: ${routingStatus.lastError ?? "unknown error"}`;
    }
  } catch (error) {
    routingWarning = `routing reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }

  recordEvent({
    appId: app.id,
    eventType: "routing-changed",
    severity: "info",
    message: choice.internalOnly
      ? `"${app.name}" was switched to internal-only (no public route)`
      : `"${app.name}" was switched to public at ${choice.domain ?? "(unknown)"}`,
    metadata: {
      previousDomain,
      previousInternalOnly,
      newDomain: choice.domain,
      newInternalOnly: choice.internalOnly
    }
  });

  if (routingWarning) {
    recordEvent({
      appId: app.id,
      eventType: "routing-warning",
      severity: "warning",
      message: `Routing warning while updating "${app.name}": ${routingWarning}`
    });
  }

  return {
    success: true,
    message: routingWarning
      ? `App routing updated, but ${routingWarning}.`
      : "App routing updated successfully.",
    domain: choice.domain,
    internalOnly: choice.internalOnly
  };
}
