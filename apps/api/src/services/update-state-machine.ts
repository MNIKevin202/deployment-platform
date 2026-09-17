/**
 * The self-updater's durable state machine. Pure definitions + transition
 * validation only — persistence lives on the host (the always-alive updater
 * owns `${INSTALL_ROOT}/state/update-state.json`) and is mirrored into the
 * database for the UI. See docs/SELF_UPDATE_ARCHITECTURE.md "Update state
 * machine". Keeping the legal-transition graph here, in tested TypeScript,
 * means the host script and the API agree on what a valid transition is
 * rather than each encoding its own ad-hoc rules.
 */

export const UPDATE_STATES = [
  "idle",
  "checking",
  "update_available",
  "downloading",
  "verifying",
  "preparing",
  "installing",
  "migrating",
  "health_checking",
  "successful",
  "rolling_back",
  "rolled_back",
  "failed",
  "manual_intervention_required"
] as const;

export type UpdateState = (typeof UPDATE_STATES)[number];

/**
 * States from which the updater is between checks and safe to start a fresh
 * cycle. Everything else means an update is (or was) in flight and must be
 * reconciled before a new one begins.
 */
const RESTING_STATES: ReadonlySet<UpdateState> = new Set<UpdateState>([
  "idle",
  "update_available",
  "successful",
  "rolled_back",
  "failed"
]);

/**
 * States where real, disruptive work is underway or a cutover has begun.
 * If the updater process restarts and finds itself recorded in one of these,
 * an update was interrupted and startup reconciliation must resolve it
 * (verify the running version, roll back, or flag manual intervention) —
 * never blindly begin another update on top.
 */
const IN_FLIGHT_STATES: ReadonlySet<UpdateState> = new Set<UpdateState>([
  "downloading",
  "verifying",
  "preparing",
  "installing",
  "migrating",
  "health_checking",
  "rolling_back"
]);

/**
 * A cutover (container swap) has begun by the time we reach these — a
 * restart here cannot assume the old version is still serving, so
 * reconciliation must inspect what is actually running rather than assume
 * "nothing happened".
 */
const POST_CUTOVER_STATES: ReadonlySet<UpdateState> = new Set<UpdateState>([
  "installing",
  "migrating",
  "health_checking",
  "rolling_back"
]);

/** Terminal states — an update cycle has ended; the next cycle starts from here. */
const TERMINAL_STATES: ReadonlySet<UpdateState> = new Set<UpdateState>([
  "successful",
  "rolled_back",
  "failed",
  "manual_intervention_required"
]);

const LEGAL_TRANSITIONS: Readonly<Record<UpdateState, ReadonlyArray<UpdateState>>> = {
  idle: ["checking"],
  checking: ["idle", "update_available", "failed"],
  update_available: ["checking", "downloading", "idle"],
  downloading: ["verifying", "failed"],
  verifying: ["preparing", "failed"],
  preparing: ["installing", "failed"],
  installing: ["migrating", "health_checking", "rolling_back", "failed", "manual_intervention_required"],
  migrating: ["health_checking", "rolling_back", "manual_intervention_required", "failed"],
  health_checking: ["successful", "rolling_back", "manual_intervention_required", "failed"],
  successful: ["idle", "checking"],
  rolling_back: ["rolled_back", "manual_intervention_required"],
  rolled_back: ["idle", "checking"],
  failed: ["idle", "checking"],
  // A stuck installation is only ever cleared by an operator; the updater
  // never automatically leaves this state on its own, so a repeated failure
  // can't silently loop. An explicit operator action re-enters "checking".
  manual_intervention_required: ["checking"]
};

export function isUpdateState(value: unknown): value is UpdateState {
  return typeof value === "string" && (UPDATE_STATES as readonly string[]).includes(value);
}

export function isResting(state: UpdateState): boolean {
  return RESTING_STATES.has(state);
}

export function isInFlight(state: UpdateState): boolean {
  return IN_FLIGHT_STATES.has(state);
}

export function isTerminal(state: UpdateState): boolean {
  return TERMINAL_STATES.has(state);
}

/** True once a cutover may have begun — reconciliation must inspect real state, not assume no-op. */
export function isPostCutover(state: UpdateState): boolean {
  return POST_CUTOVER_STATES.has(state);
}

export function canTransition(from: UpdateState, to: UpdateState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Given the state persisted before an interruption, what a fresh updater
 * process should do on startup:
 * - a resting/terminal state: nothing to reconcile, resume normal checking;
 * - a pre-cutover in-flight state (downloading/verifying/preparing): the old
 *   version was never touched, so it is safe to abandon the attempt and
 *   return to idle;
 * - a post-cutover state (installing and beyond): a swap may be half-done —
 *   the updater must inspect what is actually running to decide.
 */
export type RecoveryAction = "resume-normal" | "abandon-safe" | "inspect-running";

export function recoveryActionFor(state: UpdateState): RecoveryAction {
  if (isResting(state) || isTerminal(state)) {
    return "resume-normal";
  }
  if (isPostCutover(state)) {
    return "inspect-running";
  }
  // Pre-cutover in-flight: downloading / verifying / preparing.
  return "abandon-safe";
}
