import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";

describe("provider credentials (database layer)", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-credential-db-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);
  });

  function cleanup() {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  test("returns null when no credential exists yet", () => {
    assert.equal(appDatabase.getProviderCredential("github"), null);
    cleanup();
  });

  test("persists the encrypted payload and metadata, never a plaintext token column", () => {
    const created = appDatabase.upsertProviderCredential({
      provider: "github",
      encryptedPayload: JSON.stringify({ v: 1, iv: "aaa", tag: "bbb", data: "ccc" }),
      authenticatedUsername: "octocat",
      permissionsJson: null,
      lastValidatedAt: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(created.provider, "github");
    assert.equal(created.authenticatedUsername, "octocat");
    assert.ok(created.encryptedPayload.length > 0);

    // The raw row has exactly the documented columns — no plaintext token
    // column exists to accidentally populate.
    const row = appDatabase.db
      .prepare("SELECT * FROM provider_credentials WHERE provider = ?")
      .get("github") as Record<string, unknown>;

    assert.deepEqual(
      Object.keys(row).sort(),
      [
        "authenticated_username",
        "created_at",
        "encrypted_payload",
        "id",
        "last_validated_at",
        "permissions_json",
        "provider",
        "updated_at"
      ].sort()
    );

    cleanup();
  });

  test("enforces one credential per provider — saving again replaces it in place", () => {
    appDatabase.upsertProviderCredential({
      provider: "github",
      encryptedPayload: "first-payload",
      authenticatedUsername: "octocat",
      permissionsJson: null,
      lastValidatedAt: "2026-01-01T00:00:00.000Z"
    });

    const replaced = appDatabase.upsertProviderCredential({
      provider: "github",
      encryptedPayload: "second-payload",
      authenticatedUsername: "octocat2",
      permissionsJson: null,
      lastValidatedAt: "2026-01-02T00:00:00.000Z"
    });

    assert.equal(replaced.encryptedPayload, "second-payload");
    assert.equal(replaced.authenticatedUsername, "octocat2");

    const count = appDatabase.db
      .prepare("SELECT COUNT(*) AS count FROM provider_credentials WHERE provider = ?")
      .get("github") as { count: number };

    assert.equal(count.count, 1);

    cleanup();
  });

  test("deletion removes the credential", () => {
    appDatabase.upsertProviderCredential({
      provider: "github",
      encryptedPayload: "payload",
      authenticatedUsername: "octocat",
      permissionsJson: null,
      lastValidatedAt: null
    });

    appDatabase.deleteProviderCredential("github");

    assert.equal(appDatabase.getProviderCredential("github"), null);

    cleanup();
  });

  test("getProviderCredential never returns a decrypted token — only the stored ciphertext blob", () => {
    appDatabase.upsertProviderCredential({
      provider: "github",
      encryptedPayload: JSON.stringify({ v: 1, iv: "aaa", tag: "bbb", data: "ccc" }),
      authenticatedUsername: "octocat",
      permissionsJson: null,
      lastValidatedAt: null
    });

    const stored = appDatabase.getProviderCredential("github");
    assert.ok(stored);
    // The only "token" field is the encrypted payload; there is no getter
    // that returns anything else.
    assert.deepEqual(Object.keys(stored as object).sort(), [
      "authenticatedUsername",
      "createdAt",
      "encryptedPayload",
      "id",
      "lastValidatedAt",
      "permissionsJson",
      "provider",
      "updatedAt"
    ].sort());

    cleanup();
  });
});
