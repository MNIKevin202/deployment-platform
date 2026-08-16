import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { redactConnectionString } from "../connection-redaction.js";

describe("redactConnectionString", () => {
  test("masks the password in a MongoDB Atlas SRV URI but keeps the shape", () => {
    const redacted = redactConnectionString(
      "mongodb+srv://appuser:s3cr3tpw@cluster0.ab12c.mongodb.net/?retryWrites=true"
    );
    assert.ok(!redacted.includes("s3cr3tpw"));
    assert.ok(redacted.startsWith("mongodb+srv://appuser:"));
    assert.ok(redacted.endsWith("@cluster0.ab12c.mongodb.net/?retryWrites=true"));
  });

  test("masks the password in a Postgres URI", () => {
    assert.equal(
      redactConnectionString("postgresql://blueprint:hunter2@db.example.com:5432/app"),
      "postgresql://blueprint:••••@db.example.com:5432/app"
    );
  });

  test("keeps a userless URI recognizable without inventing a password", () => {
    assert.equal(
      redactConnectionString("redis://cache.example.com:6379"),
      "redis://cache.example.com:6379"
    );
  });

  test("masks a URI that has a user but no password", () => {
    assert.equal(
      redactConnectionString("mongodb://appuser@host:27017/db"),
      "mongodb://appuser@host:27017/db"
    );
  });

  test("reduces an unstructured string to a short, non-reversible hint", () => {
    const redacted = redactConnectionString("AccountKey=abcdef1234567890");
    assert.ok(redacted.startsWith("Acco"));
    assert.ok(!redacted.includes("abcdef"));
    assert.ok(redacted.length < "AccountKey=abcdef1234567890".length);
  });

  test("fully masks a short unstructured string", () => {
    const redacted = redactConnectionString("short");
    assert.ok(!redacted.includes("short"));
    assert.ok(redacted.length > 0);
  });

  test("returns empty for an empty string", () => {
    assert.equal(redactConnectionString("   "), "");
  });
});
