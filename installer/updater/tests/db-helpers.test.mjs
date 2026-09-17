import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const UPDATER = join(HERE, "..");
const READ = join(UPDATER, "db-read-config.mjs");
const SEED = join(UPDATER, "db-seed-config.mjs");
const WRITE = join(UPDATER, "db-write-setting.mjs");
const HISTORY = join(UPDATER, "db-history.mjs");

let dir;
let dbPath;

function run(script, env = {}) {
  return execFileSync("node", [script], {
    encoding: "utf8",
    env: { ...process.env, DP_DB_PATH: dbPath, ...env }
  });
}

function openDb() {
  return new DatabaseSync(dbPath);
}

/** Simulate a LEGACY production DB: platform_settings exists (migration 018)
 *  and schema_migrations has some applied versions — but NO update-* keys and
 *  NO app-level helper methods (we only ever touch it via raw SQL). */
function seedLegacyDb() {
  const db = openDb();
  db.exec(
    "CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  );
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (let v = 1; v <= 27; v += 1) {
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(v, `m${v}`);
  }
  // An unrelated existing setting that must be preserved untouched.
  db.prepare("INSERT INTO platform_settings (key, value) VALUES (?, ?)").run(
    "auto_backup",
    JSON.stringify({ enabled: true, intervalHours: 24, retention: 7 })
  );
  db.close();
}

describe("updater DB helpers (raw SQL, legacy-compatible)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clovaforge-dbhelpers-"));
    dbPath = join(dir, "deployment-platform.sqlite");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("read-config on a legacy DB with no update keys returns nulls but the real appliedMax", () => {
    seedLegacyDb();
    const out = JSON.parse(run(READ));
    assert.equal(out.settings, null);
    assert.equal(out.pending, null);
    assert.equal(out.appliedMax, 27);
  });

  test("seed-config writes settings via raw SQL on a legacy DB (no getJsonSetting needed)", () => {
    seedLegacyDb();
    const seeded = JSON.parse(run(SEED, { DP_CHANNEL: "beta", DP_POLICY: "notify_only" }));
    assert.equal(seeded.channel, "beta");
    assert.equal(seeded.policy, "notify_only");
    assert.ok(seeded.manifestBaseUrl.includes("/releases/download"));

    const out = JSON.parse(run(READ));
    assert.equal(out.settings.channel, "beta");
    assert.equal(out.settings.policy, "notify_only");
  });

  test("seed-config preserves unrelated existing settings", () => {
    seedLegacyDb();
    run(SEED, { DP_CHANNEL: "beta", DP_POLICY: "notify_only" });
    const db = openDb();
    const ab = JSON.parse(db.prepare("SELECT value FROM platform_settings WHERE key='auto_backup'").get().value);
    db.close();
    assert.deepEqual(ab, { enabled: true, intervalHours: 24, retention: 7 });
  });

  test("seed-config is idempotent and preserves a stored manifestBaseUrl and window", () => {
    seedLegacyDb();
    // First seed, then simulate an operator customizing base URL + window.
    run(SEED, { DP_CHANNEL: "beta", DP_POLICY: "notify_only" });
    const db1 = openDb();
    const s1 = JSON.parse(db1.prepare("SELECT value FROM platform_settings WHERE key='platform_update_settings'").get().value);
    s1.manifestBaseUrl = "https://custom.example.com/dl";
    s1.maintenanceWindow = { start: "02:00", end: "04:00", timezone: "UTC" };
    db1.prepare("UPDATE platform_settings SET value=? WHERE key='platform_update_settings'").run(JSON.stringify(s1));
    db1.close();

    // Re-run seed (idempotent bootstrap re-apply) with different channel/policy.
    run(SEED, { DP_CHANNEL: "stable", DP_POLICY: "automatic_patch" });
    const out = JSON.parse(run(READ));
    assert.equal(out.settings.channel, "stable");
    assert.equal(out.settings.policy, "automatic_patch");
    assert.equal(out.settings.manifestBaseUrl, "https://custom.example.com/dl", "preserved custom base URL");
    assert.deepEqual(out.settings.maintenanceWindow, { start: "02:00", end: "04:00", timezone: "UTC" }, "preserved window");
  });

  test("seed-config seeds an idle state once and never clobbers an in-flight state", () => {
    seedLegacyDb();
    run(SEED, { DP_CHANNEL: "beta", DP_POLICY: "notify_only" });
    // Simulate an in-flight update state.
    run(WRITE, { DP_KEY: "platform_update_state", DP_VALUE_B64: Buffer.from(JSON.stringify({ state: "installing", targetVersion: "1.3.0" })).toString("base64") });
    // Re-run seed: must NOT reset the state back to idle.
    run(SEED, { DP_CHANNEL: "beta", DP_POLICY: "notify_only" });
    const db = openDb();
    const st = JSON.parse(db.prepare("SELECT value FROM platform_settings WHERE key='platform_update_state'").get().value);
    db.close();
    assert.equal(st.state, "installing");
  });

  test("write-setting sets and deletes a key (raw SQL)", () => {
    seedLegacyDb();
    run(WRITE, { DP_KEY: "platform_update_apply_request", DP_VALUE_B64: Buffer.from(JSON.stringify({ targetVersion: "1.3.0", trigger: "manual" })).toString("base64") });
    let out = JSON.parse(run(READ));
    assert.equal(out.pending.targetVersion, "1.3.0");
    // Empty value deletes.
    run(WRITE, { DP_KEY: "platform_update_apply_request", DP_VALUE_B64: "" });
    out = JSON.parse(run(READ));
    assert.equal(out.pending, null);
  });

  test("history start/finish creates the table on a legacy DB and prunes", () => {
    seedLegacyDb();
    const id = run(HISTORY, { DP_OP: "start", DP_FROM: "1.2.6", DP_TO: "1.3.0", DP_CHANNEL: "beta", DP_POLICY: "notify_only", DP_TRIGGER: "manual" }).trim();
    assert.ok(Number(id) > 0);
    run(HISTORY, { DP_OP: "finish", DP_ID: id, DP_RESULT: "successful", DP_HEALTH: "passed", DP_KEEP: "50" });
    const db = openDb();
    const row = db.prepare("SELECT * FROM platform_update_history WHERE id = ?").get(Number(id));
    db.close();
    assert.equal(row.result, "successful");
    assert.equal(row.to_version, "1.3.0");
    assert.equal(row.from_version, "1.2.6");
  });

  test("read-config never throws on a totally empty DB (no tables at all)", () => {
    // brand-new empty DB file
    const out = JSON.parse(run(READ));
    assert.equal(out.settings, null);
    assert.equal(out.pending, null);
    assert.equal(out.appliedMax, 0);
  });
});
