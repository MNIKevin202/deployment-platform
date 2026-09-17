import { compareSemVer, isPatchOnlyUpgrade, parseSemVer } from "./semver.js";

/**
 * Update-policy and maintenance-window evaluation for the platform's
 * self-updater. Pure functions only — no IO, no clock except the `now`
 * a caller passes in — so every rule here is directly and exhaustively
 * testable. See docs/SELF_UPDATE_ARCHITECTURE.md "Update policies" and
 * "Maintenance windows".
 */

export const UPDATE_POLICIES = ["notify_only", "automatic_patch", "automatic"] as const;
export type UpdatePolicy = (typeof UPDATE_POLICIES)[number];

export function isUpdatePolicy(value: unknown): value is UpdatePolicy {
  return typeof value === "string" && (UPDATE_POLICIES as readonly string[]).includes(value);
}

/**
 * Whether upgrading from `currentVersion` to `targetVersion` crosses a major
 * version boundary. A major upgrade is NEVER applied automatically under any
 * policy — it must be an explicit, operator-initiated action. This is the
 * one hard rule that protects customer installations from being force-moved
 * across a deliberately-breaking release line.
 */
export function isMajorUpgrade(currentVersion: string, targetVersion: string): boolean {
  return parseSemVer(targetVersion).major > parseSemVer(currentVersion).major;
}

export type AutoApplyDecision = {
  autoApplyAllowed: boolean;
  /** A short, stable reason code — surfaced in status/history, safe to show an operator. */
  reason:
    | "not-an-upgrade"
    | "manual-approval-required"
    | "policy-notify-only"
    | "major-requires-manual"
    | "minor-requires-manual-under-patch-policy"
    | "allowed";
};

/**
 * Decides whether an available upgrade may be applied **automatically**
 * (i.e. without an operator pressing "Update Now") under a given policy.
 * A manual, operator-initiated apply is governed separately — it is allowed
 * for any real upgrade the operator can see, except one the release itself
 * marks `requiresManualApproval` is still applied only manually, never
 * automatically. Maintenance-window enforcement is layered on top of this
 * by the caller; this function answers policy alone.
 */
export function evaluateAutoApply(options: {
  policy: UpdatePolicy;
  currentVersion: string;
  targetVersion: string;
  requiresManualApproval: boolean;
}): AutoApplyDecision {
  const { policy, currentVersion, targetVersion, requiresManualApproval } = options;

  if (compareSemVer(targetVersion, currentVersion) <= 0) {
    return { autoApplyAllowed: false, reason: "not-an-upgrade" };
  }

  // A release the publisher flagged for manual approval is never automatic,
  // regardless of policy — this is the kill switch for a release that turned
  // out to need human attention.
  if (requiresManualApproval) {
    return { autoApplyAllowed: false, reason: "manual-approval-required" };
  }

  if (policy === "notify_only") {
    return { autoApplyAllowed: false, reason: "policy-notify-only" };
  }

  // A major bump is never automatic under any policy.
  if (isMajorUpgrade(currentVersion, targetVersion)) {
    return { autoApplyAllowed: false, reason: "major-requires-manual" };
  }

  if (policy === "automatic_patch") {
    // Patch-only (same major.minor) may auto-apply; a minor bump may not.
    if (isPatchOnlyUpgrade(currentVersion, targetVersion)) {
      return { autoApplyAllowed: true, reason: "allowed" };
    }
    return { autoApplyAllowed: false, reason: "minor-requires-manual-under-patch-policy" };
  }

  // policy === "automatic": any non-major upgrade (patch or minor) is allowed.
  return { autoApplyAllowed: true, reason: "allowed" };
}

// ============================================================
// Maintenance windows
// ============================================================

export interface MaintenanceWindow {
  /** "HH:MM" 24-hour local start, in `timezone`. */
  start: string;
  /** "HH:MM" 24-hour local end, in `timezone`. Equal to start means an empty (never-open) window. */
  end: string;
  /** IANA timezone name, e.g. "UTC", "America/New_York". */
  timezone: string;
}

const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Validates a MaintenanceWindow's shape, including that the timezone is one the runtime accepts. */
export function isValidMaintenanceWindow(window: unknown): window is MaintenanceWindow {
  if (typeof window !== "object" || window === null) {
    return false;
  }
  const candidate = window as Record<string, unknown>;
  if (typeof candidate.start !== "string" || typeof candidate.end !== "string" || typeof candidate.timezone !== "string") {
    return false;
  }
  if (!HHMM_PATTERN.test(candidate.start) || !HHMM_PATTERN.test(candidate.end)) {
    return false;
  }
  return isValidTimeZone(candidate.timezone);
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes since local midnight for a "HH:MM" string. */
function toMinutes(hhmm: string): number {
  const match = HHMM_PATTERN.exec(hhmm);
  if (!match) {
    throw new Error(`Invalid HH:MM time: ${hhmm}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The wall-clock minutes-since-midnight for `now` in the given IANA timezone. */
function minutesSinceMidnightInZone(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  // Intl can render midnight as "24" in some engines/locales; normalize.
  const normalizedHour = hour === 24 ? 0 : hour;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return normalizedHour * 60 + minute;
}

/**
 * Whether `now` falls inside the window, evaluated in the window's own
 * timezone and correctly handling a window that crosses midnight (e.g.
 * 23:00–02:00). A `null` window means "no window configured" → always open
 * (automatic updates may run any time). A window whose start equals its end
 * is treated as never-open, so an operator can positively disable automatic
 * timing without deleting the field.
 */
export function isWithinMaintenanceWindow(window: MaintenanceWindow | null, now: Date): boolean {
  if (window === null) {
    return true;
  }
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === end) {
    // Deliberately never-open (an explicit "no automatic time" marker).
    return false;
  }
  const current = minutesSinceMidnightInZone(now, window.timezone);
  if (start < end) {
    // Same-day window: [start, end).
    return current >= start && current < end;
  }
  // Crosses midnight: open from start..24:00 and 00:00..end.
  return current >= start || current < end;
}
