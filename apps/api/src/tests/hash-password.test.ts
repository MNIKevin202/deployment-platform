import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hashPassword, verifyPassword } from "../auth.js";

describe("hashPassword / verifyPassword round trip", () => {
  test("a freshly hashed password verifies", () => {
    const hash = hashPassword("correct horse battery staple");
    assert.equal(verifyPassword("correct horse battery staple", hash), true);
  });

  test("a wrong password does not verify", () => {
    const hash = hashPassword("s3cret-pass");
    assert.equal(verifyPassword("not-the-password", hash), false);
  });

  test("hashing the same password twice yields different hashes (random salt)", () => {
    assert.notEqual(hashPassword("same"), hashPassword("same"));
  });

  test("produces the canonical <64 hex salt>:<128 hex key> shape", () => {
    const [salt, key] = hashPassword("x").split(":");
    assert.equal(salt.length, 64);
    assert.equal(key.length, 128);
    assert.match(salt, /^[0-9a-f]+$/);
    assert.match(key, /^[0-9a-f]+$/);
  });
});
