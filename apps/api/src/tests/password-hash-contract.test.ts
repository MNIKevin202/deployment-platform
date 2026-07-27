import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { describe, test } from "node:test";
import { verifyPassword } from "../auth.js";

/**
 * Contract test between the installer's password hashing and this API's
 * login verifier.
 *
 * The installer never runs Node on the host: it computes
 * ADMIN_PASSWORD_HASH inside a sandboxed node:24-alpine helper container
 * (installer/lib/secrets.sh -> compute_password_hash). If that helper's
 * salt length, key length, encoding, or separator ever drifts from what
 * verifyPassword() expects, every login silently returns 401 and the
 * only symptom is an operator who "cannot log in" — exactly the failure
 * shape that is expensive to diagnose from logs alone.
 *
 * installerHashingLogic() below is a byte-for-byte transcription of the
 * helper script embedded in compute_password_hash. It must stay in sync
 * with that script; the assertions then run the REAL production
 * verifier against its output.
 *
 * Passwords here are local fixtures only and are never logged.
 */
function installerHashingLogic(password: string): string {
  // Mirrors installer/lib/secrets.sh compute_password_hash:
  //   const salt = randomBytes(32);
  //   const derivedKey = scryptSync(password, salt, 64);
  //   `${salt.toString("hex")}:${derivedKey.toString("hex")}`
  const salt = randomBytes(32);
  const derivedKey = scryptSync(password, salt, 64);

  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

describe("installer/API password hash contract", () => {
  test("the API verifier accepts a hash produced by the installer's logic", () => {
    const password = "correct horse battery staple";
    const hash = installerHashingLogic(password);

    assert.equal(verifyPassword(password, hash), true);
  });

  test("the API verifier rejects a wrong password against the same hash", () => {
    const hash = installerHashingLogic("correct horse battery staple");

    assert.equal(verifyPassword("wrong horse battery staple", hash), false);
    assert.equal(verifyPassword("", hash), false);
    assert.equal(
      verifyPassword("correct horse battery stapl", hash),
      false
    );
  });

  test("installer output shape matches what the verifier parses", () => {
    const hash = installerHashingLogic("another valid password 123");
    const [saltHex, hashHex, ...extra] = hash.split(":");

    assert.equal(extra.length, 0, "exactly one ':' separator");
    // 32-byte salt and 64-byte derived key, hex encoded.
    assert.equal(saltHex.length, 64, "salt is 32 bytes of hex");
    assert.equal(hashHex.length, 128, "derived key is 64 bytes of hex");
    assert.match(hash, /^[0-9a-f]+:[0-9a-f]+$/, "lowercase hex only");
  });

  test("the derived key length is fixed by the canonical format, not by the stored hash", () => {
    // verifyPassword() must derive scryptSync(password, salt, 64) from a
    // constant. Deriving from expectedHash.length instead made the stored
    // value the authority on its own format: truncating the stored hash
    // shortened the derivation to match, so a truncated (weaker) hash
    // still verified.
    const password = "length agreement password";
    const salt = randomBytes(32);
    const derivedKey = scryptSync(password, salt, 64);
    const hash = `${salt.toString("hex")}:${derivedKey.toString("hex")}`;

    assert.equal(verifyPassword(password, hash), true);

    // A hash truncated to a different key length must not verify.
    const truncated = `${salt.toString("hex")}:${derivedKey
      .subarray(0, 32)
      .toString("hex")}`;
    assert.equal(verifyPassword(password, truncated), false);
  });

  test("canonical output remains 64 hex salt + colon + 128 hex hash", () => {
    // Pins the exact shape the API's parser now requires, so a change to
    // either side breaks loudly here rather than silently at login.
    const hash = installerHashingLogic("canonical shape password");
    const [saltHex, hashHex] = hash.split(":");

    assert.equal(hash.split(":").length, 2);
    assert.equal(saltHex.length, 64);
    assert.equal(hashHex.length, 128);
    assert.equal(hash.length, 64 + 1 + 128);
    assert.match(hash, /^[0-9a-f]{64}:[0-9a-f]{128}$/);
  });

  test("a single trailing newline is what the installer strips, nothing more", () => {
    // The helper reads its mounted password file with
    // .replace(/\n$/, ""), so a file written with a trailing newline and
    // one written without must hash the same password. Anything beyond
    // one trailing newline is part of the password.
    const password = "trailing newline password";

    assert.equal(`${password}\n`.replace(/\n$/, ""), password);
    assert.notEqual(`${password}\n\n`.replace(/\n$/, ""), password);

    const hash = installerHashingLogic(password);
    assert.equal(verifyPassword(password, hash), true);
    assert.equal(verifyPassword(`${password}\n`, hash), false);
  });
});

describe("stored password hash format validation", () => {
  // A single fixed password/salt pair, so every malformed variant below
  // differs from the canonical hash ONLY in the way it is named. Any of
  // these verifying would mean the stored value — not the code — decides
  // the required cryptographic format.
  const PASSWORD = "canonical format password";
  // A FIXED salt, not randomBytes: it makes every case below fully
  // deterministic, and it guarantees SALT_HEX contains hex letters so the
  // uppercase-rejection cases genuinely differ from the canonical value
  // (a random salt whose hex happened to be all digits would make those
  // cases vacuous). Real salt generation is random and is covered by the
  // installer-logic block above; this block tests format validation only.
  const SALT = Buffer.from("ab".repeat(32), "hex");
  const KEY = scryptSync(PASSWORD, SALT, 64);
  const SALT_HEX = SALT.toString("hex");
  const KEY_HEX = KEY.toString("hex");
  const CANONICAL = `${SALT_HEX}:${KEY_HEX}`;

  test("the canonical installer hash verifies", () => {
    assert.equal(verifyPassword(PASSWORD, CANONICAL), true);
  });

  test("a wrong password fails against a canonical hash", () => {
    assert.equal(verifyPassword("not the password", CANONICAL), false);
  });

  test("an empty password fails against a canonical hash", () => {
    assert.equal(verifyPassword("", CANONICAL), false);
  });

  // Every entry is [description, malformed stored hash]. All must be
  // rejected, and none may throw.
  const malformedHashes: Array<[string, string]> = [
    // Derived-key length: the original vulnerability and its neighbours.
    ["a 32-byte truncated derived key", `${SALT_HEX}:${KEY.subarray(0, 32).toString("hex")}`],
    ["a 63-byte derived key", `${SALT_HEX}:${KEY.subarray(0, 63).toString("hex")}`],
    ["a 65-byte derived key", `${SALT_HEX}:${KEY_HEX}${"ab"}`],
    ["an empty derived key", `${SALT_HEX}:`],
    // Salt length.
    ["a truncated 16-byte salt", `${SALT.subarray(0, 16).toString("hex")}:${KEY_HEX}`],
    ["an oversized 48-byte salt", `${randomBytes(48).toString("hex")}:${KEY_HEX}`],
    ["an empty salt", `:${KEY_HEX}`],
    // Character-set and encoding rules.
    ["uppercase hex in the salt", `${SALT_HEX.toUpperCase()}:${KEY_HEX}`],
    ["uppercase hex in the derived key", `${SALT_HEX}:${KEY_HEX.toUpperCase()}`],
    ["non-hex characters in the salt", `${"z".repeat(64)}:${KEY_HEX}`],
    ["non-hex characters in the derived key", `${SALT_HEX}:${"z".repeat(128)}`],
    ["odd-length hex in the derived key", `${SALT_HEX}:${KEY_HEX.slice(0, 127)}`],
    ["odd-length hex in the salt", `${SALT_HEX.slice(0, 63)}:${KEY_HEX}`],
    // Separator rules.
    ["an extra colon", `${SALT_HEX}:${KEY_HEX}:extra`],
    ["a colon inside the derived key", `${SALT_HEX}:${KEY_HEX.slice(0, 64)}:${KEY_HEX.slice(64)}`],
    ["a missing colon", `${SALT_HEX}${KEY_HEX}`],
    ["only a colon", ":"],
    // Whitespace and emptiness.
    ["leading whitespace", ` ${CANONICAL}`],
    ["trailing whitespace", `${CANONICAL} `],
    ["a trailing newline", `${CANONICAL}\n`],
    ["surrounding whitespace", `\t${CANONICAL}\n`],
    ["an empty string", ""],
    ["whitespace only", "   "],
    // Shapes a corrupted config might plausibly produce.
    ["the salt alone", SALT_HEX],
    ["the derived key alone", KEY_HEX],
    ["an unrelated string", "not-a-hash-at-all"]
  ];

  for (const [description, malformed] of malformedHashes) {
    test(`${description} fails verification`, () => {
      assert.equal(verifyPassword(PASSWORD, malformed), false);
    });

    test(`${description} does not throw`, () => {
      // Malformed stored hashes must degrade to "no match", never crash a
      // login request.
      assert.doesNotThrow(() => verifyPassword(PASSWORD, malformed));
    });
  }
});
