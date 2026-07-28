import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

interface TableInfoRow {
  name: string;
}

function columnExists(
  db: DatabaseSync,
  table: string,
  column: string
): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as TableInfoRow[];

  return rows.some((row) => row.name === column);
}

/**
 * Adds explicit, persisted support for apps that should never receive a
 * public domain/route ("internal only" — e.g. a Postgres app that only
 * another managed app should ever reach, over Docker DNS on the shared
 * `deployment-apps` network).
 *
 * Before this migration, "no domain" meant only "domain is currently
 * NULL" — a state `backfillMissingAppDomains()` (server.ts) treats as
 * "not yet assigned one" and fills in on every restart. That is correct
 * for legacy apps predating automatic domains, but wrong for an app that
 * was deliberately created with no public route: it would silently
 * become public again on the platform's next restart. `internal_only`
 * makes "no domain, on purpose" a persisted fact the backfill can check
 * and permanently skip, instead of an ambiguous null.
 *
 * Existing apps all become internal_only=false — their current domain
 * (assigned or NULL-and-backfillable) is unchanged. This is intentionally
 * NOT inferred from "domain IS NULL" at migration time: a legacy app with
 * a null domain keeps today's backfill behavior (it gets a domain
 * assigned), it is not silently reclassified as internal-only.
 */
export const migration013InternalOnlyApps: Migration = {
  version: 13,
  name: "internal_only_apps",
  up(db: DatabaseSync): void {
    if (!columnExists(db, "apps", "internal_only")) {
      db.exec(
        `ALTER TABLE apps ADD COLUMN internal_only INTEGER NOT NULL DEFAULT 0`
      );
    }

    // Case-insensitive, normalized uniqueness for non-null domains at the
    // database layer, as defense in depth alongside the service-layer check
    // in app-creation-service.ts / the domain-update service. Domains are
    // always normalized to lowercase before they are ever stored (see
    // domain.ts's validateCustomDomain / buildAppDomain), so in practice
    // this expression index and the plain index from migration 002 accept
    // the same rows — but the expression index is what actually enforces
    // "two apps may not use the same domain" even if a value were ever
    // stored with different casing.
    db.exec(`
      DROP INDEX IF EXISTS idx_apps_domain;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_domain_ci
      ON apps(LOWER(domain))
      WHERE domain IS NOT NULL;
    `);
  }
};
