import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildBriefRequestSchema,
  createAppWizardSchema
} from "../schemas/app-wizard.js";

describe("createAppWizardSchema", () => {
  test("accepts a full valid payload", () => {
    const result = createAppWizardSchema.safeParse({
      name: "my-app",
      image: "nginx:alpine",
      containerPort: 8080,
      restartPolicy: "always",
      environmentVariables: [
        { key: "API_URL", value: "https://example.com", isSecret: false, enabled: true },
        { key: "DB_PASSWORD", value: "hunter2", isSecret: true, enabled: true }
      ],
      storageMounts: [
        { containerPath: "/data", readOnly: false },
        { containerPath: "/config", volumeName: "my-app-cfg", readOnly: true }
      ]
    });

    assert.equal(result.success, true);
  });

  test("accepts a minimal payload and applies defaults", () => {
    const result = createAppWizardSchema.safeParse({
      name: "bare-app",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, true);

    if (result.success) {
      assert.equal(result.data.restartPolicy, "unless-stopped");
      assert.deepEqual(result.data.environmentVariables, []);
      assert.deepEqual(result.data.storageMounts, []);
    }
  });

  test("rejects duplicate environment variable keys", () => {
    const result = createAppWizardSchema.safeParse({
      name: "dup-env",
      image: "nginx:alpine",
      containerPort: 80,
      environmentVariables: [
        { key: "SAME_KEY", value: "1", isSecret: false, enabled: true },
        { key: "SAME_KEY", value: "2", isSecret: false, enabled: true }
      ]
    });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error.message, /Duplicate environment variable keys/);
    }
  });

  test("rejects duplicate storage container paths", () => {
    const result = createAppWizardSchema.safeParse({
      name: "dup-path",
      image: "nginx:alpine",
      containerPort: 80,
      storageMounts: [
        { containerPath: "/data", readOnly: false },
        { containerPath: "/data", readOnly: true }
      ]
    });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error.message, /Duplicate container paths/);
    }
  });

  test("rejects duplicate explicit volume names", () => {
    const result = createAppWizardSchema.safeParse({
      name: "dup-volname",
      image: "nginx:alpine",
      containerPort: 80,
      storageMounts: [
        { containerPath: "/data", volumeName: "shared-vol", readOnly: false },
        { containerPath: "/config", volumeName: "shared-vol", readOnly: false }
      ]
    });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error.message, /Duplicate volume names/);
    }
  });

  test("rejects an invalid app name", () => {
    const result = createAppWizardSchema.safeParse({
      name: "Invalid Name!",
      image: "nginx:alpine",
      containerPort: 80
    });

    assert.equal(result.success, false);
  });

  test("rejects an invalid restart policy", () => {
    const result = createAppWizardSchema.safeParse({
      name: "bad-policy",
      image: "nginx:alpine",
      containerPort: 80,
      restartPolicy: "sometimes"
    });

    assert.equal(result.success, false);
  });

  test("rejects a reserved container path", () => {
    const result = createAppWizardSchema.safeParse({
      name: "bad-path",
      image: "nginx:alpine",
      containerPort: 80,
      storageMounts: [{ containerPath: "/etc", readOnly: false }]
    });

    assert.equal(result.success, false);
  });
});

describe("buildBriefRequestSchema", () => {
  test("accepts a full valid payload", () => {
    const result = buildBriefRequestSchema.safeParse({
      appName: "my-app",
      image: "nginx:alpine",
      containerPort: 3000,
      runtime: "nodejs",
      description: "A small internal tool.",
      startCommand: "node server.js",
      healthCheckPath: "/health",
      environmentVariables: [
        { key: "API_URL", isSecret: false },
        { key: "DB_PASSWORD", isSecret: true }
      ],
      storageMounts: [{ containerPath: "/data", readOnly: false }]
    });

    assert.equal(result.success, true);
  });

  test("accepts a minimal payload and applies defaults", () => {
    const result = buildBriefRequestSchema.safeParse({
      appName: "bare-app",
      containerPort: 3000,
      runtime: "docker"
    });

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.image, "");
      assert.deepEqual(result.data.environmentVariables, []);
      assert.deepEqual(result.data.storageMounts, []);
    }
  });

  test("rejects an invalid runtime value", () => {
    const result = buildBriefRequestSchema.safeParse({
      appName: "bad-runtime",
      containerPort: 3000,
      runtime: "ruby"
    });

    assert.equal(result.success, false);
  });

  test("never accepts a value field on environment variables", () => {
    const result = buildBriefRequestSchema.safeParse({
      appName: "leaky",
      containerPort: 3000,
      runtime: "nodejs",
      environmentVariables: [{ key: "SECRET_KEY", isSecret: true, value: "should not be accepted" }]
    });

    assert.equal(result.success, true);
    if (result.success) {
      const envVar = result.data.environmentVariables[0] as unknown as Record<string, unknown>;
      assert.equal("value" in envVar, false);
    }
  });
});
