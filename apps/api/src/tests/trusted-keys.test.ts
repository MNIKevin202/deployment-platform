import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadTrustedKeysFromDir } from "../services/trusted-keys.js";

function writePublicKey(dir: string, keyId: string): void {
  const { publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(dir, `${keyId}.pem`), publicKey.export({ type: "spki", format: "pem" }).toString());
}

describe("loadTrustedKeysFromDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clovaforge-trusted-keys-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing directory yields an empty map (fail closed)", () => {
    assert.deepEqual(loadTrustedKeysFromDir(join(dir, "does-not-exist")), {});
  });

  test("loads every well-named .pem, keyed by basename", () => {
    writePublicKey(dir, "clovaforge-release-1");
    writePublicKey(dir, "clovaforge-release-2");
    const keys = loadTrustedKeysFromDir(dir);
    assert.deepEqual(Object.keys(keys).sort(), ["clovaforge-release-1", "clovaforge-release-2"]);
    assert.ok(keys["clovaforge-release-1"].includes("BEGIN PUBLIC KEY"));
  });

  test("ignores non-.pem files and files whose contents are not a public key", () => {
    writePublicKey(dir, "good");
    writeFileSync(join(dir, "notes.txt"), "not a key");
    writeFileSync(join(dir, "empty.pem"), "");
    writeFileSync(join(dir, "private-looking.pem"), "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----");
    const keys = loadTrustedKeysFromDir(dir);
    assert.deepEqual(Object.keys(keys), ["good"]);
  });

  test("skips a filename that is not a safe keyId", () => {
    writePublicKey(dir, "ok");
    // A traversal-ish basename must never be loaded as a keyId.
    writeFileSync(join(dir, "..evil.pem"), "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----");
    const keys = loadTrustedKeysFromDir(dir);
    assert.deepEqual(Object.keys(keys), ["ok"]);
  });
});
