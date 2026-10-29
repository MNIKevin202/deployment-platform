import { randomUUID } from "node:crypto";

/**
 * Ownership and fencing for migratable subjects (docs/MIGRATION_DESIGN.md §6.4).
 *
 * Exactly one server owns the LIVE copy of a subject. Only a `live` record may
 * serve traffic or run schedulers, cron, auto-deploy, health checks or webhooks.
 * Every other state is inert. All functions are pure: they take a record and
 * return a new one (or throw), so the protocol is testable without any server.
 */

export const OWNERSHIP_STATES = [
  "live",
  "frozen-for-migration",
  "standby",
  "dormant-copy",
  "retired-after-move"
] as const;
export type OwnershipState = (typeof OWNERSHIP_STATES)[number];

export interface OwnershipRecord {
  /** e.g. "app:12". */
  subject: string;
  /** A move keeps the lineage; a copy starts a new one. */
  lineageId: string;
  ownerServerId: string;
  /** Monotonic fencing epoch. Increments whenever authority changes hands or is revoked. */
  epoch: number;
  state: OwnershipState;
  migrationId: string | null;
  /** For `retired-after-move`: where the live copy now is. */
  movedToServerId: string | null;
  /** For `dormant-copy`: the lineage it was copied from (informational only). */
  copiedFromLineageId: string | null;
  since: string;
}

/** Proof, issued by the SOURCE when it fences, that no further writes will occur there. */
export interface FenceReceipt {
  migrationId: string;
  subject: string;
  lineageId: string;
  sourceServerId: string;
  /** The source's epoch at the moment of fencing. */
  epoch: number;
  fencedAt: string;
}

export type OwnershipErrorCode =
  | "INVALID_STATE"
  | "MIGRATION_MISMATCH"
  | "RECEIPT_REQUIRED"
  | "RECEIPT_MISMATCH"
  | "STALE_RECEIPT"
  | "ACKNOWLEDGEMENT_REQUIRED"
  | "DOUBLE_LIVE";

export class OwnershipError extends Error {
  constructor(
    readonly code: OwnershipErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OwnershipError";
  }
}

type Clock = () => Date;
const defaultClock: Clock = () => new Date();

export function newLiveRecord(options: {
  subject: string;
  serverId: string;
  lineageId?: string;
  now?: Clock;
}): OwnershipRecord {
  return {
    subject: options.subject,
    lineageId: options.lineageId ?? randomUUID(),
    ownerServerId: options.serverId,
    epoch: 1,
    state: "live",
    migrationId: null,
    movedToServerId: null,
    copiedFromLineageId: null,
    since: (options.now ?? defaultClock)().toISOString()
  };
}

function requireState(record: OwnershipRecord, state: OwnershipState, action: string): void {
  if (record.state !== state) {
    throw new OwnershipError(
      "INVALID_STATE",
      `Cannot ${action}: the subject is "${record.state}", it must be "${state}".`
    );
  }
}

function requireMigration(record: OwnershipRecord, migrationId: string, action: string): void {
  if (record.migrationId !== migrationId) {
    throw new OwnershipError(
      "MIGRATION_MISMATCH",
      `Cannot ${action}: the subject belongs to a different migration.`
    );
  }
}

// ----------------------------------------------------------- source side ----

/** live → frozen-for-migration. Issued BEFORE the final snapshot so no later write can exist. */
export function fence(
  record: OwnershipRecord,
  migrationId: string,
  now: Clock = defaultClock
): { record: OwnershipRecord; receipt: FenceReceipt } {
  requireState(record, "live", "fence");
  const at = now().toISOString();

  return {
    record: { ...record, state: "frozen-for-migration", migrationId, since: at },
    receipt: {
      migrationId,
      subject: record.subject,
      lineageId: record.lineageId,
      sourceServerId: record.ownerServerId,
      epoch: record.epoch,
      fencedAt: at
    }
  };
}

/**
 * Rollback: frozen-for-migration → live. The epoch is INCREMENTED so any receipt
 * that was issued for the abandoned attempt is now stale and can never activate
 * a destination copy.
 */
export function unfence(record: OwnershipRecord, migrationId: string, now: Clock = defaultClock): OwnershipRecord {
  requireState(record, "frozen-for-migration", "unfence");
  requireMigration(record, migrationId, "unfence");

  return {
    ...record,
    state: "live",
    epoch: record.epoch + 1,
    migrationId: null,
    since: now().toISOString()
  };
}

/** Commit, source side: frozen-for-migration → retired-after-move. Rollback is no longer possible. */
export function retire(
  record: OwnershipRecord,
  migrationId: string,
  movedToServerId: string,
  now: Clock = defaultClock
): OwnershipRecord {
  requireState(record, "frozen-for-migration", "retire");
  requireMigration(record, migrationId, "retire");

  return {
    ...record,
    state: "retired-after-move",
    movedToServerId,
    since: now().toISOString()
  };
}

// ------------------------------------------------------ destination side ----

/** Destination of a MOVE: holds the imported copy inert until activated with the receipt. */
export function createStandby(options: {
  receipt: FenceReceipt;
  destinationServerId: string;
  now?: Clock;
}): OwnershipRecord {
  const { receipt } = options;

  return {
    subject: receipt.subject,
    lineageId: receipt.lineageId,
    ownerServerId: options.destinationServerId,
    // The destination's epoch is always one ahead of the source's fenced epoch.
    epoch: receipt.epoch + 1,
    state: "standby",
    migrationId: receipt.migrationId,
    movedToServerId: null,
    copiedFromLineageId: null,
    since: (options.now ?? defaultClock)().toISOString()
  };
}

/** standby → live. Requires the matching, non-stale fence receipt. */
export function activateStandby(
  record: OwnershipRecord,
  receipt: FenceReceipt | null | undefined,
  now: Clock = defaultClock
): OwnershipRecord {
  requireState(record, "standby", "activate");

  if (!receipt) {
    throw new OwnershipError(
      "RECEIPT_REQUIRED",
      "A moved application can only go live with the source's fence receipt."
    );
  }
  if (
    receipt.migrationId !== record.migrationId ||
    receipt.subject !== record.subject ||
    receipt.lineageId !== record.lineageId
  ) {
    throw new OwnershipError("RECEIPT_MISMATCH", "The fence receipt is for a different migration or subject.");
  }
  if (receipt.epoch + 1 !== record.epoch) {
    throw new OwnershipError(
      "STALE_RECEIPT",
      "The fence receipt is stale: the source's authority changed after it was issued (was the move rolled back?)."
    );
  }

  return { ...record, state: "live", since: now().toISOString() };
}

/** Rollback, destination side: a standby is simply removed (represented as null). */
export function discardStandby(record: OwnershipRecord, migrationId: string): null {
  requireState(record, "standby", "discard the standby");
  requireMigration(record, migrationId, "discard the standby");

  return null;
}

// ---------------------------------------------------------------- copies ----

/** Destination of a COPY: a new lineage, dormant — every side effect stays off. */
export function createDormantCopy(options: {
  subject: string;
  destinationServerId: string;
  sourceLineageId: string;
  migrationId: string;
  now?: Clock;
}): OwnershipRecord {
  return {
    subject: options.subject,
    lineageId: randomUUID(),
    ownerServerId: options.destinationServerId,
    epoch: 1,
    state: "dormant-copy",
    migrationId: options.migrationId,
    movedToServerId: null,
    copiedFromLineageId: options.sourceLineageId,
    since: (options.now ?? defaultClock)().toISOString()
  };
}

/** dormant-copy → live, as an independent app. Requires explicit acknowledgement of the side effects. */
export function promoteDormantCopy(
  record: OwnershipRecord,
  acknowledgedSideEffects: boolean,
  now: Clock = defaultClock
): OwnershipRecord {
  requireState(record, "dormant-copy", "promote the copy");

  if (!acknowledgedSideEffects) {
    throw new OwnershipError(
      "ACKNOWLEDGEMENT_REQUIRED",
      "Promoting a copy re-enables cron jobs, auto-deploy and notifications. Acknowledge this explicitly."
    );
  }

  return { ...record, state: "live", migrationId: null, since: now().toISOString() };
}

// ------------------------------------------------------------ invariants ----

/** True only for `live`: the sole state in which any side effect may run. */
export function sideEffectsAllowed(record: OwnershipRecord): boolean {
  return record.state === "live";
}

/** Throws if a moved lineage is live on both servers at once. */
export function assertNotDoubleLive(a: OwnershipRecord | null, b: OwnershipRecord | null): void {
  if (a && b && a.lineageId === b.lineageId && a.state === "live" && b.state === "live") {
    throw new OwnershipError(
      "DOUBLE_LIVE",
      `Subject ${a.subject} is live on both ${a.ownerServerId} and ${b.ownerServerId}.`
    );
  }
}

/** Plain-language label for the UI's "which server owns this app" indicator. */
export function describeOwnership(record: OwnershipRecord, thisServerId: string): string {
  const where = record.ownerServerId === thisServerId ? "this server" : record.ownerServerId;

  switch (record.state) {
    case "live":
      return `Live on ${where}`;
    case "frozen-for-migration":
      return `Frozen on ${where} — migration in progress (not serving)`;
    case "standby":
      return `Standby on ${where} — will go live at cutover`;
    case "dormant-copy":
      return `Dormant copy on ${where} — not running schedulers or serving traffic`;
    case "retired-after-move":
      return `Moved to ${record.movedToServerId ?? "another server"} — retired here`;
  }
}
