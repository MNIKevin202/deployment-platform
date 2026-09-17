import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { RELEASE_CHANNELS, type ReleaseChannel } from "../schemas/release-manifest.js";
import { computeRollbackSafety, getAppliedMaxVersion } from "../migrations/index.js";
import {
  fetchAndVerifyManifest,
  evaluateUpdateAvailability,
  type ManifestResult
} from "../services/release-manifest-service.js";
import { isValidSemVer } from "../services/semver.js";
import {
  UPDATE_POLICIES,
  evaluateAutoApply,
  isValidMaintenanceWindow,
  type MaintenanceWindow,
  type UpdatePolicy
} from "../services/update-policy.js";
import { isUpdateState, type UpdateState } from "../services/update-state-machine.js";

/**
 * Platform self-update status/settings/history — the API surface for
 * ClovaForge updating ITSELF. See docs/SELF_UPDATE_ARCHITECTURE.md.
 *
 * Scope boundary (deliberate): every route here reads a manifest, reads/
 * writes a small settings record, reads history, or records an apply
 * request. **None of them pull an image, touch a container, or run a
 * migration.** The component that can safely replace the API's own
 * container is the host-level updater, outside this container (a container
 * cannot finish swapping itself — see the architecture doc). This route
 * only ever *records a request* for that host agent to act on, using the
 * exact host↔container boundary the existing updater already uses to read
 * the GitHub token. There is deliberately no endpoint that runs an
 * arbitrary command, fetches an arbitrary URL, or applies an unverified
 * version.
 *
 * All routes inherit the platform's global session authentication (the
 * onRequest hook in auth.ts) — there is no parallel auth model for updates.
 *
 * Unrelated to image-update-check-service.ts, which checks for newer images
 * of apps *hosted on* the platform.
 */

export const UPDATE_SETTINGS_KEY = "platform_update_settings";
export const UPDATE_STATUS_CACHE_KEY = "platform_update_status_cache";
export const UPDATE_STATE_KEY = "platform_update_state";
export const UPDATE_APPLY_REQUEST_KEY = "platform_update_apply_request";

/**
 * Default manifest base — this project's own GitHub Releases download root.
 * The installer overwrites it per-install; this default means a stock
 * install's stable-channel check works with no extra configuration once
 * releases exist. Channel manifest/signature URLs are derived from it, so
 * switching channel never means re-entering a URL.
 */
export const DEFAULT_MANIFEST_BASE_URL =
  "https://github.com/MNIKevin202/deployment-platform/releases/download";

export interface UpdateSettings {
  channel: ReleaseChannel;
  policy: UpdatePolicy;
  /** HTTPS base URL; per-channel manifest/sig URLs are derived as `${base}/${channel}-latest/...`. */
  manifestBaseUrl: string;
  maintenanceWindow: MaintenanceWindow | null;
}

const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  channel: "stable",
  policy: "notify_only",
  manifestBaseUrl: DEFAULT_MANIFEST_BASE_URL,
  maintenanceWindow: null
};

const maintenanceWindowSchema = z
  .object({
    start: z.string(),
    end: z.string(),
    timezone: z.string()
  })
  .refine(isValidMaintenanceWindow, "Invalid maintenance window (need HH:MM start/end and a valid IANA timezone)");

const updateSettingsSchema = z.object({
  channel: z.enum(RELEASE_CHANNELS),
  policy: z.enum(UPDATE_POLICIES),
  manifestBaseUrl: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), "Must be HTTPS")
    .refine((url) => !url.includes(".."), "Must not contain '..'"),
  maintenanceWindow: maintenanceWindowSchema.nullable()
});

/** Derives the concrete manifest + signature URLs for a settings record's channel. */
export function channelManifestUrls(settings: UpdateSettings): {
  manifestUrl: string;
  signatureUrl: string;
} {
  const base = settings.manifestBaseUrl.replace(/\/+$/, "");
  const dir = `${base}/${settings.channel}-latest`;
  return { manifestUrl: `${dir}/manifest.json`, signatureUrl: `${dir}/manifest.json.sig` };
}

type CheckResult =
  | {
      outcome: "up-to-date" | "update-available";
      latestVersion: string;
      requiresIncrementalUpgrade: boolean;
      requiresManualApproval: boolean;
      rollbackSafe: boolean;
      /** Whether the current policy would auto-apply this (informational; the host agent is authoritative). */
      autoApplyEligible: boolean;
      autoApplyReason: string;
    }
  | { outcome: "check-failed"; reason: string; detail: string };

export interface UpdateStatusCache {
  lastCheckedAt: string;
  result: CheckResult;
}

/** The live state the host updater mirrors into the DB for the UI. */
export interface LiveUpdateState {
  state: UpdateState;
  targetVersion: string | null;
  detail: string | null;
  updatedAt: string;
}

interface RegisterPlatformUpdateRoutesOptions {
  appDatabase: AppDatabase;
  /** The version this running instance actually is (apps/api/Dockerfile's APP_VERSION build arg). */
  currentVersion: string;
  /** Injectable for tests; defaults to fetchAndVerifyManifest's real-fetch default. */
  checkManifest?: (manifestUrl: string, signatureUrl: string) => Promise<ManifestResult>;
}

export function readUpdateSettings(appDatabase: AppDatabase): UpdateSettings {
  return appDatabase.getJsonSetting<UpdateSettings>(UPDATE_SETTINGS_KEY) ?? DEFAULT_UPDATE_SETTINGS;
}

export function readLiveUpdateState(appDatabase: AppDatabase): LiveUpdateState {
  const stored = appDatabase.getJsonSetting<LiveUpdateState>(UPDATE_STATE_KEY);
  if (stored && isUpdateState(stored.state)) {
    return stored;
  }
  return { state: "idle", targetVersion: null, detail: null, updatedAt: new Date(0).toISOString() };
}

export async function registerPlatformUpdateRoutes(
  fastify: FastifyInstance,
  { appDatabase, currentVersion, checkManifest = fetchAndVerifyManifest }: RegisterPlatformUpdateRoutesOptions
): Promise<void> {
  async function runCheck(): Promise<UpdateStatusCache> {
    const settings = readUpdateSettings(appDatabase);
    const now = new Date().toISOString();
    const { manifestUrl, signatureUrl } = channelManifestUrls(settings);

    const manifestResult = await checkManifest(manifestUrl, signatureUrl);

    let status: UpdateStatusCache;
    if (!manifestResult.success) {
      status = {
        lastCheckedAt: now,
        result: { outcome: "check-failed", reason: manifestResult.reason, detail: manifestResult.detail }
      };
    } else {
      const availability = evaluateUpdateAvailability(currentVersion, manifestResult.manifest);
      const appliedMaxVersion = getAppliedMaxVersion(appDatabase.db);
      const autoApply = evaluateAutoApply({
        policy: settings.policy,
        currentVersion,
        targetVersion: availability.latestVersion,
        requiresManualApproval: availability.requiresManualApproval
      });
      status = {
        lastCheckedAt: now,
        result: {
          outcome: availability.updateAvailable ? "update-available" : "up-to-date",
          latestVersion: availability.latestVersion,
          requiresIncrementalUpgrade: availability.requiresIncrementalUpgrade,
          requiresManualApproval: availability.requiresManualApproval,
          rollbackSafe: computeRollbackSafety(appliedMaxVersion),
          autoApplyEligible: availability.updateAvailable && autoApply.autoApplyAllowed,
          autoApplyReason: autoApply.reason
        }
      };
    }

    appDatabase.setJsonSetting(UPDATE_STATUS_CACHE_KEY, status);
    return status;
  }

  fastify.get("/platform/updates/settings", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async () => {
    const settings = readUpdateSettings(appDatabase);
    return { success: true, settings, currentVersion, derivedUrls: channelManifestUrls(settings) };
  });

  fastify.put("/platform/updates/settings", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = updateSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ success: false, message: "Invalid update settings.", errors: parsed.error.flatten() });
    }
    appDatabase.setJsonSetting(UPDATE_SETTINGS_KEY, parsed.data);
    return { success: true, settings: parsed.data };
  });

  fastify.get("/platform/updates/status", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async () => {
    return {
      success: true,
      currentVersion,
      status: appDatabase.getJsonSetting<UpdateStatusCache>(UPDATE_STATUS_CACHE_KEY),
      state: readLiveUpdateState(appDatabase),
      latestSuccessfulUpdate: appDatabase.getLatestSuccessfulUpdate()
    };
  });

  fastify.post("/platform/updates/check", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async () => {
    const status = await runCheck();
    return { success: true, currentVersion, status };
  });

  fastify.get("/platform/updates/history", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const query = request.query as { limit?: string };
    const limit = query.limit ? Number(query.limit) : 50;
    return { success: true, history: appDatabase.listUpdateHistory(Number.isFinite(limit) ? limit : 50) };
  });

  // Records a manual apply request only — never applies anything itself (see
  // the file-level doc). The target must be a version this installation has
  // actually verified in its own most recent "update-available" check — never
  // an arbitrary caller-supplied string, which would let anyone reaching this
  // authenticated route request an "update" to a version nobody verified.
  fastify.post("/platform/updates/request-apply", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (_request, reply) => {
    const cached = appDatabase.getJsonSetting<UpdateStatusCache>(UPDATE_STATUS_CACHE_KEY);
    if (!cached || cached.result.outcome !== "update-available") {
      return reply.code(409).send({
        success: false,
        message: "No verified update is available to apply. Run a check first."
      });
    }
    if (cached.result.requiresIncrementalUpgrade) {
      return reply.code(409).send({
        success: false,
        message: "This installation is too old to upgrade directly to the latest release. An incremental upgrade is required."
      });
    }
    const targetVersion = cached.result.latestVersion;
    if (!isValidSemVer(targetVersion)) {
      return reply.code(500).send({ success: false, message: "Cached update status has an invalid version." });
    }

    // A manual, operator-initiated apply overrides the maintenance-window
    // timing restriction (the operator is present and asking now) but never
    // the requiresManualApproval kill switch — which, being manual, this
    // request already satisfies.
    appDatabase.setJsonSetting(UPDATE_APPLY_REQUEST_KEY, {
      requestedAt: new Date().toISOString(),
      targetVersion,
      trigger: "manual"
    });

    return {
      success: true,
      message: `An update to ${targetVersion} has been requested. The host update agent applies it on its next cycle.`,
      targetVersion
    };
  });
}
