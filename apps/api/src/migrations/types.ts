import type { DatabaseSync } from "node:sqlite";

/**
 * A migration's forward-compatibility classification, declared by whoever
 * wrote it — see docs/SELF_UPDATE_ARCHITECTURE.md "Migration safety".
 *
 * "expand": old code can still run against the schema this migration
 * produces (a new nullable column, a new table, a new index, a benign
 * backfill of a column nothing yet reads). Rolling the running image back
 * to a version older than this migration remains safe.
 *
 * "breaking": it is not (a column was dropped/renamed/tightened, a
 * NOT NULL constraint was added without a safe default, data was
 * transformed in a way older code depends on differently). Rolling back
 * past this migration requires restoring the pre-migration database
 * backup, not just swapping the container image back.
 *
 * Required, not optional: a migration author must make this call
 * explicitly rather than the platform silently guessing. The platform's
 * own rollback-safety check additionally treats any migration it cannot
 * find a classification for at all as "breaking" — see
 * computeRollbackSafety in index.ts.
 */
export type MigrationRisk = "expand" | "breaking";

export interface Migration {
  version: number;
  name: string;
  risk: MigrationRisk;
  up: (db: DatabaseSync) => void;
}
