import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { computeRollbackSafety, getAppliedMaxVersion, listMigrations, runMigrations } from "../migrations/index.js";

describe("migration risk classification", () => {
  test("every migration declares an explicit risk", () => {
    for (const migration of listMigrations()) {
      assert.ok(
        migration.risk === "expand" || migration.risk === "breaking",
        `migration ${migration.version} (${migration.name}) has no valid risk classification`
      );
    }
  });

  test("migrations are exposed in ascending version order", () => {
    const versions = listMigrations().map((migration) => migration.version);
    const sorted = [...versions].sort((a, b) => a - b);
    assert.deepEqual(versions, sorted);
  });
});

describe("computeRollbackSafety", () => {
  test("true when nothing newer than the previous version has run (no-op upgrade)", () => {
    const highestVersion = Math.max(...listMigrations().map((m) => m.version));
    assert.equal(computeRollbackSafety(highestVersion), true);
  });

  test("false when previousMaxVersion is before the one known 'breaking' migration (002)", () => {
    // Migration 002 (expand_apps_columns) backfills a column via UPDATE —
    // classified "breaking" out of documented conservatism. An install at
    // version 1 upgrading past it must not be told an automatic rollback
    // is safe.
    assert.equal(computeRollbackSafety(1), false);
  });

  test("true once previousMaxVersion is at or past the one breaking migration, through the rest of the (all-expand) history", () => {
    assert.equal(computeRollbackSafety(2), true);
    const highestVersion = Math.max(...listMigrations().map((m) => m.risk === "breaking" ? m.version : 0));
    assert.equal(computeRollbackSafety(highestVersion), true);
  });

  test("previousMaxVersion of 0 (brand-new database) is unsafe, since migration 002 is breaking and would run", () => {
    assert.equal(computeRollbackSafety(0), false);
  });

  test("the real production state (applied max 28) is a zero-migration, rollback-safe upgrade to this release", () => {
    // srv652219 reported appliedMax=28, and this release ships exactly 28
    // migrations — so a 0.1.31 -> 1.3.x upgrade runs NO migrations and is
    // vacuously rollback-safe (container swap-back only). This is why the
    // direct upgrade is genuinely safe despite the low version string.
    const PROD_APPLIED_MAX = 28;
    const highestShipped = Math.max(...listMigrations().map((m) => m.version));
    assert.equal(highestShipped, PROD_APPLIED_MAX, "this release must ship exactly the 28 migrations production has applied");
    const pending = listMigrations().filter((m) => m.version > PROD_APPLIED_MAX);
    assert.equal(pending.length, 0, "no migrations should run from the real production applied-max");
    assert.equal(computeRollbackSafety(PROD_APPLIED_MAX), true);
  });
});

describe("getAppliedMaxVersion", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-migrations-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns 0 against a database with no schema_migrations table yet", () => {
    const db = new DatabaseSync(join(tempDir, `${randomUUID()}.sqlite`));
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);");
    assert.equal(getAppliedMaxVersion(db), 0);
    db.close();
  });

  test("returns the highest applied version after a real migration run", () => {
    const db = new DatabaseSync(join(tempDir, `${randomUUID()}.sqlite`));
    runMigrations(db);
    const highestKnown = Math.max(...listMigrations().map((m) => m.version));
    assert.equal(getAppliedMaxVersion(db), highestKnown);
    db.close();
  });
});
