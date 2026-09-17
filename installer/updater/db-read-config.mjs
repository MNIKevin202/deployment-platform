// db-read-config.mjs — read the updater's configuration directly from the
// platform SQLite database via RAW SQL, with NO dependency on any app-level
// helper (getJsonSetting etc.). This is what makes the updater work against a
// LEGACY API image (e.g. 1.2.6) that predates those helpers: it opens the
// same database file the app uses and reads the platform_settings table, which
// has existed since migration 018.
//
// Run inside the API container: `docker exec -i <api> node --input-type=module < db-read-config.mjs`
// (the container has node:sqlite and the DB at /data). Env: DP_DB_PATH.
// Output: one line of JSON: { settings, pending, appliedMax }. Never throws
// for a missing table/key — a fresh/legacy DB simply yields nulls.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const dbPath = process.env.DP_DB_PATH || "/data/deployment-platform.sqlite";

// A nonexistent DB (should never happen against a running API, but be robust):
// there is nothing to read — emit nulls rather than failing the whole tick.
if (!existsSync(dbPath)) {
  process.stdout.write(JSON.stringify({ settings: null, pending: null, appliedMax: 0 }));
  process.exit(0);
}

function readJsonSetting(db, key) {
  try {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
    if (!row || typeof row.value !== "string") return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  } catch {
    // platform_settings may not exist on a brand-new DB — treat as absent.
    return null;
  }
}

function readAppliedMax(db) {
  try {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
    return row && typeof row.v === "number" ? row.v : 0;
  } catch {
    return 0;
  }
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout = 5000");
  const out = {
    settings: readJsonSetting(db, "platform_update_settings"),
    pending: readJsonSetting(db, "platform_update_apply_request"),
    appliedMax: readAppliedMax(db)
  };
  process.stdout.write(JSON.stringify(out));
} finally {
  db.close();
}
