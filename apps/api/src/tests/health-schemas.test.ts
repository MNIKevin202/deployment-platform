import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  healthCheckConfigSchema,
  healthCheckPathSchema,
  HEALTH_CHECK_DEFAULTS
} from "../schemas/health.js";

function validConfig(overrides: Partial<typeof HEALTH_CHECK_DEFAULTS> = {}) {
  return { ...HEALTH_CHECK_DEFAULTS, ...overrides };
}

describe("healthCheckPathSchema", () => {
  test("accepts a plain path", () => {
    assert.equal(healthCheckPathSchema.safeParse("/health").success, true);
    assert.equal(healthCheckPathSchema.safeParse("/api/v1/status").success, true);
  });

  test("rejects a path that does not start with /", () => {
    assert.equal(healthCheckPathSchema.safeParse("health").success, false);
  });

  test("rejects an absolute URL with a scheme and hostname", () => {
    assert.equal(healthCheckPathSchema.safeParse("http://evil.example.com/health").success, false);
    assert.equal(
      healthCheckPathSchema.safeParse("/redirect?to=http://evil.example.com").success,
      false
    );
  });

  test("rejects a protocol-relative path", () => {
    assert.equal(healthCheckPathSchema.safeParse("//evil.example.com/health").success, false);
  });

  test("rejects path traversal", () => {
    assert.equal(healthCheckPathSchema.safeParse("/../etc/passwd").success, false);
    assert.equal(healthCheckPathSchema.safeParse("/a/../../b").success, false);
  });

  test("rejects a fragment", () => {
    assert.equal(healthCheckPathSchema.safeParse("/health#fragment").success, false);
  });

  test("rejects control characters", () => {
    assert.equal(healthCheckPathSchema.safeParse("/health\n").success, false);
    assert.equal(healthCheckPathSchema.safeParse("/health\0").success, false);
  });

  test("rejects an overly long path", () => {
    assert.equal(healthCheckPathSchema.safeParse(`/${"a".repeat(600)}`).success, false);
  });
});

describe("healthCheckConfigSchema", () => {
  test("accepts the documented safe defaults", () => {
    const result = healthCheckConfigSchema.safeParse(validConfig());
    assert.equal(result.success, true);
  });

  test("rejects an expected status below 100 or above 599", () => {
    assert.equal(
      healthCheckConfigSchema.safeParse(validConfig({ expectedStatus: 99 })).success,
      false
    );
    assert.equal(
      healthCheckConfigSchema.safeParse(validConfig({ expectedStatus: 600 })).success,
      false
    );
  });

  test("rejects an interval outside the conservative bounds", () => {
    assert.equal(
      healthCheckConfigSchema.safeParse(validConfig({ intervalSeconds: 1 })).success,
      false
    );
    assert.equal(
      healthCheckConfigSchema.safeParse(validConfig({ intervalSeconds: 100000 })).success,
      false
    );
  });

  test("rejects a timeout greater than the interval", () => {
    const result = healthCheckConfigSchema.safeParse(
      validConfig({ intervalSeconds: 10, timeoutSeconds: 20 })
    );
    assert.equal(result.success, false);
  });

  test("accepts a timeout equal to the interval", () => {
    const result = healthCheckConfigSchema.safeParse(
      validConfig({ intervalSeconds: 10, timeoutSeconds: 10 })
    );
    assert.equal(result.success, true);
  });

  test("rejects non-positive or overly large thresholds", () => {
    assert.equal(
      healthCheckConfigSchema.safeParse(validConfig({ failureThreshold: 0 })).success,
      false
    );
    assert.equal(
      healthCheckConfigSchema.safeParse(validConfig({ successThreshold: 100 })).success,
      false
    );
  });

  test("does not accept custom headers or any extra unsupported fields silently changing behavior", () => {
    const parsed = healthCheckConfigSchema.safeParse(
      validConfig({
        // @ts-expect-error - deliberately testing that an unsupported field has no effect
        headers: { Authorization: "Bearer secret" }
      })
    );

    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal("headers" in parsed.data, false);
    }
  });
});
