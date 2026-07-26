import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createEnvVarSchema,
  envKeySchema,
  updateEnvVarSchema
} from "../schemas/environment.js";

describe("envKeySchema", () => {
  test("accepts conservative identifier-style keys", () => {
    assert.equal(envKeySchema.safeParse("TZ").success, true);
    assert.equal(envKeySchema.safeParse("_PRIVATE").success, true);
    assert.equal(envKeySchema.safeParse("API_URL_2").success, true);
  });

  test("rejects an empty key", () => {
    assert.equal(envKeySchema.safeParse("").success, false);
  });

  test("rejects whitespace in a key", () => {
    assert.equal(envKeySchema.safeParse("API KEY").success, false);
    assert.equal(envKeySchema.safeParse("API_KEY ").success, false);
  });

  test("rejects shell syntax", () => {
    assert.equal(envKeySchema.safeParse("$(rm -rf /)").success, false);
    assert.equal(envKeySchema.safeParse("KEY;echo hi").success, false);
    assert.equal(envKeySchema.safeParse("`whoami`").success, false);
  });

  test("rejects a key starting with a digit", () => {
    assert.equal(envKeySchema.safeParse("1KEY").success, false);
  });

  test("rejects null bytes", () => {
    assert.equal(envKeySchema.safeParse("KEY\0NAME").success, false);
  });
});

describe("createEnvVarSchema", () => {
  test("defaults isSecret and enabled when omitted", () => {
    const result = createEnvVarSchema.parse({ key: "TZ", value: "UTC" });
    assert.equal(result.isSecret, false);
    assert.equal(result.enabled, true);
  });

  test("rejects a null byte in the value", () => {
    const result = createEnvVarSchema.safeParse({
      key: "TZ",
      value: "UTC\0"
    });
    assert.equal(result.success, false);
  });

  test("rejects an excessively large value", () => {
    const result = createEnvVarSchema.safeParse({
      key: "TZ",
      value: "a".repeat(5000)
    });
    assert.equal(result.success, false);
  });
});

describe("updateEnvVarSchema", () => {
  test("requires at least one field", () => {
    assert.equal(updateEnvVarSchema.safeParse({}).success, false);
  });

  test("accepts a partial update", () => {
    assert.equal(updateEnvVarSchema.safeParse({ enabled: false }).success, true);
  });
});
