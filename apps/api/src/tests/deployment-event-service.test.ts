import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  recordEvent,
  sanitizeMetadata,
  type EventLogger
} from "../services/deployment-event-service.js";
import type { AppDatabase, CreateDeploymentEventInput } from "../database.js";

function createFakeEventDatabase() {
  const created: CreateDeploymentEventInput[] = [];

  return {
    created,
    createDeploymentEvent(input: CreateDeploymentEventInput) {
      created.push(input);
      return { id: created.length, appId: input.appId, eventType: input.eventType, severity: input.severity, message: input.message, metadataJson: input.metadataJson, createdAt: new Date().toISOString() };
    }
  } satisfies Pick<AppDatabase, "createDeploymentEvent"> & { created: CreateDeploymentEventInput[] };
}

function createFakeLogger() {
  const errors: unknown[] = [];
  const logger: EventLogger = {
    error: (obj) => {
      errors.push(obj);
    }
  };
  return { logger, errors };
}

describe("sanitizeMetadata", () => {
  test("drops keys that look like they could hold secrets", () => {
    const json = sanitizeMetadata({
      image: "nginx:alpine",
      secretToken: "abc123",
      password: "hunter2",
      apiKey: "xyz",
      authorizationHeader: "Bearer xyz"
    });

    assert.ok(json);
    const parsed = JSON.parse(json as string);
    assert.deepEqual(parsed, { image: "nginx:alpine" });
  });

  test("drops API-key-shaped keys in common naming variants, case-insensitively", () => {
    const json = sanitizeMetadata({
      apiKey: "xyz",
      API_KEY: "xyz",
      apikey: "xyz",
      "api-key": "xyz",
      stripeApiKey: "xyz",
      image: "nginx:alpine",
      statusCode: 200,
      containerId: "abc123"
    });

    assert.ok(json);
    const parsed = JSON.parse(json as string);
    // Every API-key variant is gone...
    assert.deepEqual(parsed, {
      image: "nginx:alpine",
      statusCode: 200,
      containerId: "abc123"
    });
  });

  test("does not reject ordinary keys that merely contain the word 'key'", () => {
    const json = sanitizeMetadata({
      primaryKey: 42,
      keyCount: 3,
      monkey: "not a secret"
    });

    assert.ok(json);
    const parsed = JSON.parse(json as string);
    assert.deepEqual(parsed, { primaryKey: 42, keyCount: 3, monkey: "not a secret" });
  });

  test("drops nested objects/arrays, keeping metadata flat", () => {
    const json = sanitizeMetadata({
      count: 3,
      nested: { a: 1 },
      list: [1, 2, 3]
    });

    const parsed = JSON.parse(json as string);
    assert.deepEqual(parsed, { count: 3 });
  });

  test("returns null for undefined or entirely-dropped metadata", () => {
    assert.equal(sanitizeMetadata(undefined), null);
    assert.equal(sanitizeMetadata({ secret: "x" }), null);
  });

  test("caps oversized metadata rather than storing it verbatim", () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 200; i += 1) {
      huge[`key${i}`] = "x".repeat(50);
    }

    const json = sanitizeMetadata(huge);
    assert.ok(json);
    assert.ok((json as string).length <= 200);
  });
});

describe("recordEvent", () => {
  test("writes the event with sanitized metadata", () => {
    const { created, createDeploymentEvent } = createFakeEventDatabase();
    const { logger } = createFakeLogger();

    recordEvent({ createDeploymentEvent }, logger, {
      appId: 1,
      eventType: "app-created",
      severity: "info",
      message: "App created",
      metadata: { image: "nginx:alpine", secretValue: "hunter2" }
    });

    assert.equal(created.length, 1);
    assert.equal(created[0].appId, 1);
    assert.equal(created[0].eventType, "app-created");
    assert.ok(!(created[0].metadataJson ?? "").includes("hunter2"));
  });

  test("truncates an overlong message", () => {
    const { created, createDeploymentEvent } = createFakeEventDatabase();
    const { logger } = createFakeLogger();

    recordEvent({ createDeploymentEvent }, logger, {
      appId: 1,
      eventType: "app-created",
      severity: "info",
      message: "x".repeat(1000)
    });

    assert.ok(created[0].message.length <= 500);
  });

  test("never throws when the database write fails, and logs the failure without secrets", () => {
    const { logger, errors } = createFakeLogger();

    const throwingDatabase: Pick<AppDatabase, "createDeploymentEvent"> = {
      createDeploymentEvent: () => {
        throw new Error("simulated write failure");
      }
    };

    assert.doesNotThrow(() => {
      recordEvent(throwingDatabase, logger, {
        appId: 1,
        eventType: "app-created",
        severity: "info",
        message: "App created",
        metadata: { secretValue: "hunter2" }
      });
    });

    assert.equal(errors.length, 1);
    assert.ok(!JSON.stringify(errors[0]).includes("hunter2"));
  });
});
