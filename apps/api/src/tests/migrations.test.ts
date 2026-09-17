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
