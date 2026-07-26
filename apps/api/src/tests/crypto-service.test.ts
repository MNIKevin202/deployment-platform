import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import {
  decryptSecret,
  DecryptionError,
  encryptSecret,
  loadEncryptionKey
} from "../services/crypto-service.js";

function makeKey(): Buffer {
  return randomBytes(32);
}

describe("loadEncryptionKey", () => {
  test("reports missing when the env var is unset", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;

    try {
      const status = loadEncryptionKey();
      assert.equal(status.available, false);
      if (!status.available) {
        assert.equal(status.reason, "missing");
      }
    } finally {
      if (original !== undefined) {
        process.env.CREDENTIAL_ENCRYPTION_KEY = original;
      }
    }
  });

  test("reports missing for an empty string", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = "   ";

    try {
      const status = loadEncryptionKey();
      assert.equal(status.available, false);
      if (!status.available) {
        assert.equal(status.reason, "missing");
      }
    } finally {
      if (original !== undefined) {
        process.env.CREDENTIAL_ENCRYPTION_KEY = original;
      } else {
        delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      }
    }
  });

  test("reports invalid-encoding for non-base64 input", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = "not valid base64!! ###";

    try {
      const status = loadEncryptionKey();
      assert.equal(status.available, false);
      if (!status.available) {
        assert.equal(status.reason, "invalid-encoding");
      }
    } finally {
      if (original !== undefined) {
        process.env.CREDENTIAL_ENCRYPTION_KEY = original;
      } else {
        delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      }
    }
  });

  test("reports invalid-length for a base64 string that doesn't decode to 32 bytes", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.from("too short").toString("base64");

    try {
      const status = loadEncryptionKey();
      assert.equal(status.available, false);
      if (!status.available) {
        assert.equal(status.reason, "invalid-length");
      }
    } finally {
      if (original !== undefined) {
        process.env.CREDENTIAL_ENCRYPTION_KEY = original;
      } else {
        delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      }
    }
  });

  test("accepts a valid base64-encoded 32-byte key", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = makeKey().toString("base64");

    try {
      const status = loadEncryptionKey();
      assert.equal(status.available, true);
      if (status.available) {
        assert.equal(status.key.length, 32);
      }
    } finally {
      if (original !== undefined) {
        process.env.CREDENTIAL_ENCRYPTION_KEY = original;
      } else {
        delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      }
    }
  });
});

describe("encryptSecret / decryptSecret", () => {
  test("round-trips plaintext exactly", () => {
    const key = makeKey();
    const plaintext = "github_pat_11ABCDEFG_verylongtokenvalue1234567890";

    const encrypted = encryptSecret(key, plaintext);
    const decrypted = decryptSecret(key, encrypted);

    assert.equal(decrypted, plaintext);
  });

  test("uses a different IV for identical plaintext, producing different ciphertext", () => {
    const key = makeKey();
    const plaintext = "same-token-value";

    const first = JSON.parse(encryptSecret(key, plaintext));
    const second = JSON.parse(encryptSecret(key, plaintext));

    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.data, second.data);
  });

  test("stores a versioned payload", () => {
    const key = makeKey();
    const payload = JSON.parse(encryptSecret(key, "value"));
    assert.equal(payload.v, 1);
    assert.ok(payload.iv);
    assert.ok(payload.tag);
    assert.ok(payload.data);
  });

  test("rejects a key that is not exactly 32 bytes", () => {
    const shortKey = randomBytes(16);
    assert.throws(() => encryptSecret(shortKey, "value"));
    assert.throws(() => decryptSecret(shortKey, "{}"));
  });

  test("rejects a malformed payload", () => {
    const key = makeKey();
    assert.throws(() => decryptSecret(key, "not json"), DecryptionError);
    assert.throws(() => decryptSecret(key, "{}"), DecryptionError);
    assert.throws(() => decryptSecret(key, JSON.stringify({ v: 1, iv: "x" })), DecryptionError);
  });

  test("rejects an unsupported payload version", () => {
    const key = makeKey();
    const encrypted = JSON.parse(encryptSecret(key, "value"));
    encrypted.v = 2;

    assert.throws(() => decryptSecret(key, JSON.stringify(encrypted)), DecryptionError);
  });

  test("rejects a modified ciphertext", () => {
    const key = makeKey();
    const encrypted = JSON.parse(encryptSecret(key, "value"));

    const dataBuffer = Buffer.from(encrypted.data, "base64");
    dataBuffer[0] = dataBuffer[0] ^ 0xff;
    encrypted.data = dataBuffer.toString("base64");

    assert.throws(() => decryptSecret(key, JSON.stringify(encrypted)), DecryptionError);
  });

  test("rejects a modified auth tag", () => {
    const key = makeKey();
    const encrypted = JSON.parse(encryptSecret(key, "value"));

    const tagBuffer = Buffer.from(encrypted.tag, "base64");
    tagBuffer[0] = tagBuffer[0] ^ 0xff;
    encrypted.tag = tagBuffer.toString("base64");

    assert.throws(() => decryptSecret(key, JSON.stringify(encrypted)), DecryptionError);
  });

  test("rejects decryption with the wrong key", () => {
    const key = makeKey();
    const wrongKey = makeKey();
    const encrypted = encryptSecret(key, "value");

    assert.throws(() => decryptSecret(wrongKey, encrypted), DecryptionError);
  });

  test("the token never appears verbatim in the serialized payload", () => {
    const key = makeKey();
    const token = "github_pat_super_secret_value_xyz";
    const encrypted = encryptSecret(key, token);

    assert.ok(!encrypted.includes(token));
  });

  test("rejects invalid base64 characters in iv/tag/data", () => {
    const key = makeKey();
    const encrypted = JSON.parse(encryptSecret(key, "value"));

    const withBadIv = { ...encrypted, iv: "not!!valid==base64" };
    assert.throws(() => decryptSecret(key, JSON.stringify(withBadIv)), DecryptionError);

    const withBadTag = { ...encrypted, tag: "***" };
    assert.throws(() => decryptSecret(key, JSON.stringify(withBadTag)), DecryptionError);

    const withBadData = { ...encrypted, data: "hello world spaces" };
    assert.throws(() => decryptSecret(key, JSON.stringify(withBadData)), DecryptionError);
  });

  test("rejects malformed base64 padding", () => {
    const key = makeKey();
    const encrypted = JSON.parse(encryptSecret(key, "value"));

    // A single "=" mid-string, and wrong padding-character counts, are
    // not valid standard base64 padding.
    const withBadPadding = { ...encrypted, iv: "abc=defg" };
    assert.throws(() => decryptSecret(key, JSON.stringify(withBadPadding)), DecryptionError);

    const withTooMuchPadding = { ...encrypted, tag: "abcd===" };
    assert.throws(() => decryptSecret(key, JSON.stringify(withTooMuchPadding)), DecryptionError);
  });

  test("rejects non-canonical base64 that is shape-valid but doesn't round-trip", () => {
    const key = makeKey();
    const encrypted = JSON.parse(encryptSecret(key, "value"));

    // "AB==" is shape-valid (2 chars + "==" padding) and decodes without
    // error, but its unused low bits are non-zero, so Node's own canonical
    // re-encoding of the decoded byte produces "AA==" instead — proving
    // this string was never something `encryptSecret` could have produced.
    const nonCanonical = "AB==";
    assert.notEqual(Buffer.from(nonCanonical, "base64").toString("base64"), nonCanonical);

    const withNonCanonicalIv = { ...encrypted, iv: nonCanonical };
    assert.throws(() => decryptSecret(key, JSON.stringify(withNonCanonicalIv)), DecryptionError);
  });

  test("rejects an oversized ciphertext payload", () => {
    const key = makeKey();
    const encrypted = JSON.parse(encryptSecret(key, "value"));

    const oversized = { ...encrypted, data: randomBytes(2048).toString("base64") };
    assert.throws(() => decryptSecret(key, JSON.stringify(oversized)), DecryptionError);
  });

  test("rejects a payload with extra unexpected fields", () => {
    const key = makeKey();
    const encrypted = JSON.parse(encryptSecret(key, "value"));

    const withExtraField = { ...encrypted, extra: "unexpected" };
    assert.throws(() => decryptSecret(key, JSON.stringify(withExtraField)), DecryptionError);
  });

  test("rejects a payload missing a required field", () => {
    const key = makeKey();
    const encrypted = JSON.parse(encryptSecret(key, "value"));
    const { tag: _tag, ...withoutTag } = encrypted;

    assert.throws(() => decryptSecret(key, JSON.stringify(withoutTag)), DecryptionError);
  });
});
