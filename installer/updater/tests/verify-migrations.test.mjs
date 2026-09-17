import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

// Exercises the SHIPPED pre-cutover verifier (installer/updater/verify-migrations.mjs)
// against the REAL migration source + compiled list — the exact bytes the API
// image ships (Dockerfile COPYs apps/api/src/migrations; the build emits
// apps/api/dist/migrations/index.js). This reproduces the first production
// cutover's failure class as a HARD verifier failure, and proves the happy path
// (production applied max 28 -> zero migrations to run).
const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFIER = resolve(HERE, "..", "verify-migrations.mjs");
const REPO = resolve(HERE, "..", "..", "..");
const REAL_SRC = join(REPO, "apps", "api", "src", "migrations");
const COMPILED = join(REPO, "apps", "api", "dist", "migrations", "index.js");

/** Runs the verifier; returns { code, stdout, stderr }. */
function run(env) {
  try {
    const stdout = execFileSync("node", [VERIFIER], {
      encoding: "utf8",
      env: { ...process.env, DP_COMPILED_INDEX: COMPILED, ...env }
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

let dir;
function tmpMigrations() {
  dir = mkdtempSync(join(tmpdir(), "cf-verify-mig-"));
  return dir;
}

describe("verify-migrations: real production scenario (0.1.31 -> 1.3.x, applied max 28)", () => {
  test("applied max 28 with the real source verifies with ZERO migrations to run", () => {
    const r = run({ DP_MIGRATIONS_DIR: REAL_SRC, DP_APPLIED: "28" });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.count, 28);
    assert.equal(out.max, 28);
    assert.equal(out.toRun, 0);
  });

  test("host-extraction count cross-check: a complete extraction (28) passes", () => {
    const r = run({ DP_MIGRATIONS_DIR: REAL_SRC, DP_APPLIED: "28", DP_EXPECT_COUNT: "28" });
    assert.equal(r.code, 0, r.stderr);
  });

  test("an EMPTY extraction (the production bug) is a HARD failure, never 'no migrations'", () => {
    const empty = tmpMigrations();
    const r = run({ DP_MIGRATIONS_DIR: empty, DP_APPLIED: "28" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /empty\/failed extraction is NOT/);
  });

  test("a partial host extraction (count mismatch vs the image) is a HARD failure", () => {
    const r = run({ DP_MIGRATIONS_DIR: REAL_SRC, DP_APPLIED: "28", DP_EXPECT_COUNT: "5" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /incomplete extraction/);
  });
});

describe("verify-migrations: hard-fail on bad payloads (never silently continue)", () => {
  test("a malformed migration file (no Migration header) fails to parse", () => {
    const d = tmpMigrations();
    writeFileSync(join(d, "001_bad.ts"), "export const x = { version: 1 };\n");
    const r = run({ DP_MIGRATIONS_DIR: d, DP_APPLIED: "0" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no exported ": Migration = \{" object/);
  });

  test("a source set that does not match the compiled list is rejected", () => {
    const d = tmpMigrations();
    // A single, well-formed migration — parses fine, but the compiled list has 28.
    writeFileSync(
      join(d, "001_only.ts"),
      'export const m: Migration = { version: 1, name: "only", risk: "expand", up() {} };\n'
    );
    const r = run({ DP_MIGRATIONS_DIR: d, DP_APPLIED: "0" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /does not match the compiled list/);
  });

  test("a database ahead of the target release (applied max > target max) refuses to downgrade", () => {
    const r = run({ DP_MIGRATIONS_DIR: REAL_SRC, DP_APPLIED: "99" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /refusing a downgrade/);
  });
});

process.on("exit", () => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
