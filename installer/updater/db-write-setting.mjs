// db-write-setting.mjs — write one platform_settings key via RAW SQL
// (no app helpers). Used by the updater to mirror its live state into the DB
// for the UI, and to clear/set transient keys. Value is passed base64-encoded
// in DP_VALUE_B64 to avoid any shell/JSON quoting hazards; an empty/absent
// DP_VALUE_B64 DELETES the key.
//
// Run inside the API container:
//   docker exec -i -e DP_KEY -e DP_VALUE_B64 <api> node --input-type=module < db-write-setting.mjs
// Env: DP_DB_PATH, DP_KEY, DP_VALUE_B64.

import { DatabaseSync } from "node:sqlite";

const dbPath = process.env.DP_DB_PATH || "/data/deployment-platform.sqlite";
const key = process.env.DP_KEY || "";
const valueB64 = process.env.DP_VALUE_B64 || "";

if (!key) {
  process.stderr.write("db-write-setting: DP_KEY is required\n");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
try {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  );
  if (valueB64 === "") {
    db.prepare("DELETE FROM platform_settings WHERE key = ?").run(key);
  } else {
    const value = Buffer.from(valueB64, "base64").toString("utf8");
    db.prepare(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    ).run(key, value);
  }
} finally {
  db.close();
}
