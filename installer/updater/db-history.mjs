// db-history.mjs — record platform update history via RAW SQL, creating the
// table if it does not yet exist (schema identical to migration 028) so that
// history works even on the very first update from a legacy API that has not
// run migration 028 yet. No app helpers required.
//
// Run inside the API container:
//   DP_OP=start docker exec -i -e DP_OP -e DP_FROM ... <api> node --input-type=module < db-history.mjs
// Ops:
//   start:  env DP_FROM,DP_TO,DP_CHANNEL,DP_POLICY,DP_TRIGGER -> inserts a row, prints its id
//   finish: env DP_ID,DP_RESULT,DP_STAGE,DP_HEALTH,DP_RB_ATTEMPTED,DP_RB_RESULT,DP_DIAG,DP_KEEP
//           -> updates the row and prunes to DP_KEEP rows
// Env: DP_DB_PATH, DP_OP.

import { DatabaseSync } from "node:sqlite";

const dbPath = process.env.DP_DB_PATH || "/data/deployment-platform.sqlite";
const op = process.env.DP_OP || "";

const db = new DatabaseSync(dbPath);
try {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_update_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_version TEXT,
      to_version TEXT NOT NULL,
      channel TEXT NOT NULL,
      policy TEXT NOT NULL,
      trigger TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result TEXT NOT NULL,
      failure_stage TEXT,
      health_result TEXT,
      rollback_attempted INTEGER NOT NULL DEFAULT 0,
      rollback_result TEXT,
      diagnostic TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_platform_update_history_started ON platform_update_history (id DESC);
  `);

  if (op === "start") {
    const info = db
      .prepare(
        `INSERT INTO platform_update_history (from_version, to_version, channel, policy, trigger, started_at, result)
         VALUES (?, ?, ?, ?, ?, ?, 'in_progress')`
      )
      .run(
        process.env.DP_FROM || null,
        process.env.DP_TO || "unknown",
        process.env.DP_CHANNEL || "unknown",
        process.env.DP_POLICY || "unknown",
        process.env.DP_TRIGGER || "unknown",
        new Date().toISOString()
      );
    process.stdout.write(String(info.lastInsertRowid));
  } else if (op === "finish") {
    const id = Number(process.env.DP_ID || "0");
    if (id > 0) {
      db.prepare(
        `UPDATE platform_update_history
           SET finished_at = ?, result = ?, failure_stage = ?, health_result = ?,
               rollback_attempted = ?, rollback_result = ?, diagnostic = ?
         WHERE id = ?`
      ).run(
        new Date().toISOString(),
        process.env.DP_RESULT || "failed",
        process.env.DP_STAGE || null,
        process.env.DP_HEALTH || null,
        process.env.DP_RB_ATTEMPTED === "1" ? 1 : 0,
        process.env.DP_RB_RESULT || null,
        process.env.DP_DIAG || null,
        id
      );
    }
    const keep = Math.max(1, Number(process.env.DP_KEEP || "50"));
    db.prepare(
      `DELETE FROM platform_update_history
       WHERE id NOT IN (SELECT id FROM platform_update_history ORDER BY id DESC LIMIT ?)`
    ).run(keep);
  } else {
    process.stderr.write(`db-history: unknown DP_OP '${op}'\n`);
    process.exit(1);
  }
} finally {
  db.close();
}
