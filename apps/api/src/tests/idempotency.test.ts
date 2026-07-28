import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fingerprintCreateAppRequest,
  isValidIdempotencyKey,
  readIdempotencyKeyHeader
} from "../services/idempotency.js";

describe("isValidIdempotencyKey", () => {
  test("accepts a typical crypto.randomUUID() value", () => {
    assert.equal(isValidIdempotencyKey("f47ac10b-58cc-4372-a567-0e02b2c3d479"), true);
  });

  test("rejects an empty string", () => {
    assert.equal(isValidIdempotencyKey(""), false);
  });

  test("rejects a value that is too short", () => {
    assert.equal(isValidIdempotencyKey("short"), false);
  });

  test("rejects a value with characters outside the safe set", () => {
    assert.equal(isValidIdempotencyKey("has spaces and;semicolons"), false);
    assert.equal(isValidIdempotencyKey("<script>alert(1)</script>"), false);
  });

  test("rejects a non-string value", () => {
    assert.equal(isValidIdempotencyKey(12345), false);
    assert.equal(isValidIdempotencyKey(undefined), false);
    assert.equal(isValidIdempotencyKey(null), false);
  });

  test("rejects an unreasonably long value", () => {
    assert.equal(isValidIdempotencyKey("a".repeat(500)), false);
  });
});

describe("readIdempotencyKeyHeader", () => {
  test("reports absent when the header was not sent", () => {
    assert.deepEqual(readIdempotencyKeyHeader(undefined), { present: false });
  });

  test("reports a valid key", () => {
    const result = readIdempotencyKeyHeader("a-valid-key-12345");
    assert.deepEqual(result, { present: true, valid: true, key: "a-valid-key-12345" });
  });

  test("reports invalid for a malformed value without throwing", () => {
    const result = readIdempotencyKeyHeader("bad key!");
    assert.deepEqual(result, { present: true, valid: false });
  });

  test("uses the first value when the header was sent multiple times", () => {
    const result = readIdempotencyKeyHeader(["first-valid-key-1", "second-valid-key-2"]);
    assert.deepEqual(result, { present: true, valid: true, key: "first-valid-key-1" });
  });
});

describe("fingerprintCreateAppRequest", () => {
  test("is stable for the same logical request", () => {
    const input = { name: "app-one", image: "nginx:alpine", containerPort: 80 };
    assert.equal(fingerprintCreateAppRequest(input), fingerprintCreateAppRequest({ ...input }));
  });

  test("differs when the app name differs", () => {
    const a = fingerprintCreateAppRequest({ name: "app-one", image: "nginx:alpine", containerPort: 80 });
    const b = fingerprintCreateAppRequest({ name: "app-two", image: "nginx:alpine", containerPort: 80 });
    assert.notEqual(a, b);
  });

  test("differs when environment variables differ", () => {
    const base = { name: "app-one", image: "nginx:alpine", containerPort: 80 };
    const a = fingerprintCreateAppRequest({
      ...base,
      environmentVariables: [{ key: "A", value: "1", isSecret: false, enabled: true }]
    });
    const b = fingerprintCreateAppRequest({
      ...base,
      environmentVariables: [{ key: "A", value: "2", isSecret: false, enabled: true }]
    });
    assert.notEqual(a, b);
  });

  test("treats an absent field the same as its explicit default", () => {
    const a = fingerprintCreateAppRequest({ name: "app-one", image: "nginx:alpine", containerPort: 80 });
    const b = fingerprintCreateAppRequest({
      name: "app-one",
      image: "nginx:alpine",
      containerPort: 80,
      environmentVariables: [],
      storageMounts: []
    });
    assert.equal(a, b);
  });
});
