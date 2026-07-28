import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

const SCOPE = "app-creation";

describe("idempotency keys (database layer)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-idempotency-db-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
  });

  function cleanup() {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  test("a fresh key is reserved", () => {
    const outcome = appDatabase.beginAttempt("key-1", SCOPE, "hash-a");
    assert.deepEqual(outcome, { kind: "reserved" });
    cleanup();
  });

  test("completing a reservation makes it replayable with the exact cached body", () => {
    appDatabase.beginAttempt("key-2", SCOPE, "hash-a");
    appDatabase.complete("key-2", SCOPE, 201, { success: true, message: "ok", app: { id: 1 } });

    const outcome = appDatabase.beginAttempt("key-2", SCOPE, "hash-a");
    assert.equal(outcome.kind, "replay");
    if (outcome.kind === "replay") {
      assert.equal(outcome.statusCode, 201);
      assert.deepEqual(outcome.body, { success: true, message: "ok", app: { id: 1 } });
    }
    cleanup();
  });

  test("the same key with a different request hash is a mismatch, not a replay", () => {
    appDatabase.beginAttempt("key-3", SCOPE, "hash-a");
    appDatabase.complete("key-3", SCOPE, 201, { success: true, message: "ok" });

    const outcome = appDatabase.beginAttempt("key-3", SCOPE, "hash-b");
    assert.deepEqual(outcome, { kind: "mismatch" });
    cleanup();
  });

  test("a still-reserved (in-progress) key rejects a concurrent attempt with the same hash", () => {
    appDatabase.beginAttempt("key-4", SCOPE, "hash-a");
    const outcome = appDatabase.beginAttempt("key-4", SCOPE, "hash-a");
    assert.deepEqual(outcome, { kind: "in_progress" });
    cleanup();
  });

  test("releaseFailedAttempt frees the key for a genuine retry", () => {
    appDatabase.beginAttempt("key-5", SCOPE, "hash-a");
    appDatabase.releaseFailedAttempt("key-5", SCOPE);

    const outcome = appDatabase.beginAttempt("key-5", SCOPE, "hash-a");
    assert.deepEqual(outcome, { kind: "reserved" });
    cleanup();
  });

  test("releaseFailedAttempt never removes a completed record (only a genuinely in-progress one)", () => {
    appDatabase.beginAttempt("key-6", SCOPE, "hash-a");
    appDatabase.complete("key-6", SCOPE, 201, { success: true });
    appDatabase.releaseFailedAttempt("key-6", SCOPE);

    const outcome = appDatabase.beginAttempt("key-6", SCOPE, "hash-a");
    assert.equal(outcome.kind, "replay");
    cleanup();
  });

  test("keys are scoped: the same key value in a different scope does not collide", () => {
    appDatabase.beginAttempt("shared-key", SCOPE, "hash-a");
    const outcome = appDatabase.beginAttempt("shared-key", "some-other-scope", "hash-a");
    assert.deepEqual(outcome, { kind: "reserved" });
    cleanup();
  });

  test("a completed record older than the 24-hour retention window is pruned and its key can be reused", () => {
    appDatabase.beginAttempt("key-old", SCOPE, "hash-a");
    appDatabase.complete("key-old", SCOPE, 201, { success: true });

    // Backdate the row past the documented retention window.
    appDatabase.db
      .prepare(
        `UPDATE idempotency_keys SET created_at = datetime('now', '-25 hours') WHERE key = ? AND scope = ?`
      )
      .run("key-old", SCOPE);

    // A different key's beginAttempt call triggers the lazy prune sweep.
    appDatabase.beginAttempt("unrelated-trigger-key", SCOPE, "hash-z");

    const outcome = appDatabase.beginAttempt("key-old", SCOPE, "hash-a");
    assert.deepEqual(outcome, { kind: "reserved" });
    cleanup();
  });

  test("an in-progress record older than 5 minutes is treated as abandoned and its key can be reclaimed", () => {
    appDatabase.beginAttempt("key-stuck", SCOPE, "hash-a");

    appDatabase.db
      .prepare(
        `UPDATE idempotency_keys SET created_at = datetime('now', '-10 minutes') WHERE key = ? AND scope = ?`
      )
      .run("key-stuck", SCOPE);

    const outcome = appDatabase.beginAttempt("key-stuck", SCOPE, "hash-a");
    assert.deepEqual(outcome, { kind: "reserved" });
    cleanup();
  });
});
