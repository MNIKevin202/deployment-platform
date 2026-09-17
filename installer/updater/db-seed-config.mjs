// db-seed-config.mjs — seed/merge the updater's configuration into the
// platform_settings table via RAW SQL (no app helpers, works on a legacy API).
// Idempotent and preserving: it reads any existing platform_update_settings,
// overlays channel/policy/manifestBaseUrl, preserves every other field
// (including maintenanceWindow and unknown future fields), and writes it back.
// It never touches any other settings key, and it never recreates the DB.
//
// Run inside the API container:
//   docker exec -i -e DP_CHANNEL -e DP_POLICY -e DP_MANIFEST_BASE <api> \
//     node --input-type=module < db-seed-config.mjs
// Env: DP_DB_PATH, DP_CHANNEL, DP_POLICY, DP_MANIFEST_BASE.
// Output: the resulting settings JSON.

import { DatabaseSync } from "node:sqlite";

const dbPath = process.env.DP_DB_PATH || "/data/deployment-platform.sqlite";
const channel = process.env.DP_CHANNEL || "stable";
const policy = process.env.DP_POLICY || "notify_only";
const manifestBaseFromEnv = process.env.DP_MANIFEST_BASE || "";

const db = new DatabaseSync(dbPath);
try {
  db.exec("PRAGMA busy_timeout = 5000");
  // platform_settings has existed since migration 018; CREATE IF NOT EXISTS is
  // a belt-and-braces no-op on any real install and lets this work even on a
  // hypothetically pre-018 DB without ever altering an existing table.
  db.exec(
    "CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  );

  let existing = {};
  const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get("platform_update_settings");
  if (row && typeof row.value === "string") {
    try {
      existing = JSON.parse(row.value) || {};
    } catch {
      existing = {};
    }
  }

  const merged = {
    ...existing,
    channel,
    policy,
    // Preserve an operator-set manifest base; only fall back to the env value
    // (or the project default) when none is stored yet.
    manifestBaseUrl:
      existing.manifestBaseUrl ||
      manifestBaseFromEnv ||
      "https://github.com/MNIKevin202/deployment-platform/releases/download",
    // Preserve any existing maintenance window; default to none.
    maintenanceWindow: existing.maintenanceWindow ?? null
  };

  db.prepare(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run("platform_update_settings", JSON.stringify(merged));

  // Seed an idle live-state only if none exists — never clobber an in-flight
  // state on a re-run (idempotency + crash safety).
  const stateRow = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get("platform_update_state");
  if (!stateRow) {
    db.prepare(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
    ).run(
      "platform_update_state",
      JSON.stringify({ state: "idle", targetVersion: null, detail: "bootstrapped onto registry updater", updatedAt: new Date().toISOString() })
    );
  }

  process.stdout.write(JSON.stringify(merged));
} finally {
  db.close();
}
