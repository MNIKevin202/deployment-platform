import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Single source of truth for the platform self-update operator flow, shared by
 * the Overview banner and the Settings panel. It ONLY talks to the existing
 * /api/platform/updates/* endpoints — all real update work (verify, backup,
 * swap, health, rollback) is done by the host updater. This hook reads its
 * durable state and, during an active update, polls it every ~1.5s while
 * tolerating the API restart that the container swap causes.
 */

export type LiveState =
  | "idle"
  | "checking"
  | "update_available"
  | "downloading"
  | "verifying"
  | "preparing"
  | "installing"
  | "migrating"
  | "health_checking"
  | "successful"
  | "rolling_back"
  | "rolled_back"
  | "failed"
  | "manual_intervention_required";

const IN_FLIGHT: ReadonlySet<LiveState> = new Set([
  "checking",
  "downloading",
  "verifying",
  "preparing",
  "installing",
  "migrating",
  "health_checking",
  "rolling_back"
]);

const TERMINAL: ReadonlySet<LiveState> = new Set([
  "successful",
  "rolled_back",
  "failed",
  "manual_intervention_required"
]);

/** Human, non-technical labels for each durable state (never raw shell text). */
export const PHASE_LABELS: Record<LiveState, string> = {
  idle: "Idle",
  checking: "Checking for updates…",
  update_available: "Update available",
  downloading: "Preparing update…",
  verifying: "Verifying release…",
  preparing: "Verifying migrations…",
  installing: "Installing ClovaForge…",
  migrating: "Applying database migrations…",
  health_checking: "Verifying installation…",
  successful: "Updated successfully",
  rolling_back: "Update failed — restoring previous version…",
  rolled_back: "Update failed — previous version restored",
  failed: "Update failed",
  manual_intervention_required: "Manual recovery required"
};

interface StatusCacheResult {
  outcome: "up-to-date" | "update-available" | "check-failed";
  latestVersion?: string;
  requiresIncrementalUpgrade?: boolean;
  requiresManualApproval?: boolean;
  rollbackSafe?: boolean;
  reason?: string;
  detail?: string;
}

interface StatusResponse {
  success: boolean;
  currentVersion: string;
  status: { lastCheckedAt: string; result: StatusCacheResult } | null;
  state: { state: LiveState; targetVersion: string | null; detail: string | null; updatedAt: string };
  latestSuccessfulUpdate: { toVersion: string } | null;
  updateNowAllowed?: boolean;
  pendingApply?: { targetVersion: string } | null;
}

export interface PlatformUpdateModel {
  loading: boolean;
  currentVersion: string;
  liveState: LiveState;
  detail: string | null;
  phaseLabel: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  requiresIncrementalUpgrade: boolean;
  rollbackSafe: boolean;
  /** The most recent check reached and verified a signed manifest (not check-failed). */
  signedVerified: boolean;
  lastCheckedAt: string | null;
  checkFailedReason: string | null;
  updateNowAllowed: boolean;
  pendingVersion: string | null;
  /** An update is actively running (or we are reconnecting through its restart). */
  isUpdating: boolean;
  /** The API is temporarily unreachable during the expected container swap. */
  isReconnecting: boolean;
  /** The reconnect has gone on long enough that we say "still waiting" (never "failed"). */
  reconnectingLong: boolean;
  /** The last apply was accepted but only QUEUED for the scheduled timer (bridge unavailable). */
  scheduledQueued: boolean;
  /** Human message from the last /apply response. */
  lastApplyMessage: string | null;
  /** A terminal outcome of the most recent run, if any. */
  outcome: "successful" | "rolled_back" | "failed" | "manual_intervention_required" | null;
  actionError: string | null;
  checking: boolean;
  applying: boolean;
  check: () => Promise<void>;
  apply: () => Promise<void>;
  refresh: () => Promise<void>;
  dismissOutcome: () => void;
}

const POLL_MS = 1500;

async function fetchStatus(): Promise<StatusResponse> {
  const response = await fetch("/api/platform/updates/status");
  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }
  return (await response.json()) as StatusResponse;
}

export function usePlatformUpdate(): PlatformUpdateModel {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [isReconnecting, setReconnecting] = useState(false);
  // Consecutive failed polls during an active update — after a while the UI
  // stops calling it a routine "restart" and says it is still waiting, WITHOUT
  // ever claiming the update failed (only durable state can say that).
  const [reconnectTicks, setReconnectTicks] = useState(0);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The outcome of the last /apply POST — lets the UI distinguish "starting now"
  // (immediateTrigger) from "queued for the scheduled timer" (bridge fallback).
  const [lastApply, setLastApply] = useState<{ immediateTrigger: boolean; message: string } | null>(null);
  // Once an apply is initiated we keep the flow "active" (polling, showing
  // progress, tolerating disconnects) until a terminal state is observed —
  // even across the window where state briefly reads idle/update_available.
  const [activeUpdate, setActiveUpdate] = useState(false);
  const reloadedRef = useRef(false);
  const applyingRef = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const liveState: LiveState = data?.state?.state ?? "idle";
  const result = data?.status?.result ?? null;
  const isUpdating = activeUpdate || IN_FLIGHT.has(liveState);

  const applyStatus = useCallback((next: StatusResponse) => {
    if (!mounted.current) return;
    setData(next);
    setReconnecting(false);
    setReconnectTicks(0);
    setLoading(false);
    if (TERMINAL.has(next.state.state)) {
      setActiveUpdate(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchStatus();
      applyStatus(next);
    } catch {
      // A failure here only matters during an active update (handled by the
      // poll loop's reconnect logic); on a normal load, surface nothing fatal.
      if (mounted.current) setLoading(false);
    }
  }, [applyStatus]);

  // Poll loop, active only while an update is running.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!isUpdating) {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchStatus();
        if (cancelled) return;
        applyStatus(next);
        // A successful self-update swapped BOTH containers; reload once so the
        // new web bundle (and the sidebar version) load. Guarded so we reload
        // exactly once.
        if (next.state.state === "successful" && !reloadedRef.current) {
          reloadedRef.current = true;
          setTimeout(() => {
            try {
              window.location.reload();
            } catch {
              /* non-browser env (tests) */
            }
          }, 1800);
        }
      } catch {
        // Expected during the container swap — the API is momentarily down.
        // Do NOT treat this as a failure; keep polling and tell the UI we are
        // reconnecting.
        if (!cancelled && mounted.current) {
          setReconnecting(true);
          setReconnectTicks((n) => n + 1);
        }
      } finally {
        if (!cancelled && mounted.current) {
          pollTimer.current = setTimeout(tick, POLL_MS);
        }
      }
    };
    pollTimer.current = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [isUpdating, applyStatus]);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const check = useCallback(async () => {
    setChecking(true);
    setActionError(null);
    try {
      const response = await fetch("/api/platform/updates/check", { method: "POST" });
      if (!response.ok) {
        throw new Error(`Check failed (status ${response.status}).`);
      }
      await refresh();
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : "Check failed.");
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [refresh]);

  const apply = useCallback(async () => {
    // Synchronous guard: a rapid second click (before React re-renders the
    // disabled button) must never fire a second POST /apply.
    if (applyingRef.current) {
      return;
    }
    applyingRef.current = true;
    setApplying(true);
    setActionError(null);
    reloadedRef.current = false;
    try {
      const response = await fetch("/api/platform/updates/apply", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        immediateTrigger?: boolean;
      };
      if (response.status === 202 && body.success) {
        const immediate = body.immediateTrigger === true;
        setLastApply({ immediateTrigger: immediate, message: body.message ?? "" });
        // Only show live progress when the host actually took the request now.
        // On the scheduled fallback the updater has NOT started yet, so we must
        // not pretend it is installing — the banner shows a "queued" notice.
        if (immediate) {
          setActiveUpdate(true);
        }
        await refresh();
        return;
      }
      throw new Error(body.message || `Could not start the update (status ${response.status}).`);
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : "Could not start the update.");
    } finally {
      applyingRef.current = false;
      if (mounted.current) setApplying(false);
    }
  }, [refresh]);

  const dismissOutcome = useCallback(() => {
    setActiveUpdate(false);
    void refresh();
  }, [refresh]);

  const availableVersion =
    result?.outcome === "update-available" ? result.latestVersion ?? data?.state?.targetVersion ?? null : null;

  // ~60s of failed polls (40 × 1.5s): stop calling it a routine restart, but do
  // NOT claim failure — only durable state can.
  const RECONNECT_LONG_TICKS = 40;
  const reconnectLabel =
    reconnectTicks >= RECONNECT_LONG_TICKS ? "Still waiting for ClovaForge to come back…" : "ClovaForge is restarting…";

  return {
    loading,
    currentVersion: data?.currentVersion ?? "…",
    liveState,
    detail: data?.state?.detail ?? null,
    phaseLabel: isReconnecting ? reconnectLabel : PHASE_LABELS[liveState],
    reconnectingLong: isReconnecting && reconnectTicks >= RECONNECT_LONG_TICKS,
    scheduledQueued: lastApply != null && lastApply.immediateTrigger === false && !isUpdating && !TERMINAL.has(liveState),
    lastApplyMessage: lastApply?.message ?? null,
    availableVersion,
    updateAvailable: result?.outcome === "update-available",
    requiresIncrementalUpgrade: result?.requiresIncrementalUpgrade === true,
    rollbackSafe: result?.rollbackSafe !== false,
    signedVerified: result != null && result.outcome !== "check-failed",
    lastCheckedAt: data?.status?.lastCheckedAt ?? null,
    checkFailedReason: result?.outcome === "check-failed" ? result.reason ?? "Check failed." : null,
    updateNowAllowed: data?.updateNowAllowed === true,
    pendingVersion: data?.pendingApply?.targetVersion ?? null,
    isUpdating,
    isReconnecting,
    outcome: TERMINAL.has(liveState) ? (liveState as PlatformUpdateModel["outcome"]) : null,
    actionError,
    checking,
    applying,
    check,
    apply,
    refresh,
    dismissOutcome
  };
}
