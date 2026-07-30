import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { registerEnvironmentRoutes } from "../routes/environment.js";

describe("POST /apps/:id/environment/bulk", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let app: FastifyInstance;
  let appId: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-env-bulk-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);

    const created = appDatabase.createApp({
      name: "demo",
      image: "demo:latest",
      containerPort: 3000,
      containerName: "demo"
    });
    appId = created.id;

    app = Fastify({ logger: false });
    await registerEnvironmentRoutes(app, { appDatabase });
  });

  afterEach(async () => {
    await app.close();
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates new variables from a pasted block", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/bulk`,
      payload: {
        variables: [
          { key: "mongo", value: "http://123456" },
          { key: "username", value: "testing" }
        ]
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      success: boolean;
      created: number;
      updated: number;
      variables: { key: string; value: string | null }[];
    };
    assert.equal(body.success, true);
    assert.equal(body.created, 2);
    assert.equal(body.updated, 0);
    assert.equal(body.variables.length, 2);

    const stored = appDatabase.listAppEnvVars(appId);
    assert.equal(stored.find((v) => v.key === "mongo")?.value, "http://123456");
    assert.equal(stored.find((v) => v.key === "username")?.value, "testing");
  });

  test("updates existing variables in place and reports the split", async () => {
    appDatabase.createAppEnvVar({
      appId,
      key: "mongo",
      value: "old-value",
      isSecret: false,
      enabled: true
    });

    const response = await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/bulk`,
      payload: {
        variables: [
          { key: "mongo", value: "new-value" },
          { key: "username", value: "testing" }
        ]
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { created: number; updated: number };
    assert.equal(body.created, 1);
    assert.equal(body.updated, 1);

    const stored = appDatabase.listAppEnvVars(appId);
    assert.equal(stored.find((v) => v.key === "mongo")?.value, "new-value");
  });

  test("leaves an existing variable's secret flag alone when isSecret is omitted", async () => {
    appDatabase.createAppEnvVar({
      appId,
      key: "API_KEY",
      value: "old-secret",
      isSecret: true,
      enabled: true
    });

    await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/bulk`,
      payload: {
        variables: [{ key: "API_KEY", value: "new-secret" }]
      }
    });

    const stored = appDatabase.getAppEnvVarByKey(appId, "API_KEY");
    assert.equal(stored?.isSecret, true);
    assert.equal(stored?.value, "new-secret");
  });

  test("flips an existing variable's secret flag when isSecret is explicitly set", async () => {
    appDatabase.createAppEnvVar({
      appId,
      key: "API_KEY",
      value: "old-secret",
      isSecret: true,
      enabled: true
    });

    await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/bulk`,
      payload: {
        variables: [{ key: "API_KEY", value: "new-value", isSecret: false }]
      }
    });

    assert.equal(appDatabase.getAppEnvVarByKey(appId, "API_KEY")?.isSecret, false);
  });

  test("marks individual new variables as secret per-line, without affecting others", async () => {
    appDatabase.createAppEnvVar({
      appId,
      key: "PLAIN",
      value: "visible",
      isSecret: false,
      enabled: true
    });

    await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/bulk`,
      payload: {
        variables: [
          { key: "PLAIN", value: "still-visible" },
          { key: "NEW_SECRET", value: "hidden", isSecret: true },
          { key: "NEW_PLAIN", value: "also-visible" }
        ]
      }
    });

    assert.equal(appDatabase.getAppEnvVarByKey(appId, "PLAIN")?.isSecret, false);
    assert.equal(appDatabase.getAppEnvVarByKey(appId, "NEW_SECRET")?.isSecret, true);
    assert.equal(appDatabase.getAppEnvVarByKey(appId, "NEW_PLAIN")?.isSecret, false);
  });

  test("marks the app's environment as pending exactly once", async () => {
    assert.equal(appDatabase.getAppById(appId)?.environmentTouchedAt, null);

    await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/bulk`,
      payload: {
        variables: [
          { key: "A", value: "1" },
          { key: "B", value: "2" }
        ]
      }
    });

    assert.notEqual(appDatabase.getAppById(appId)?.environmentTouchedAt, null);
  });

  test("rejects an invalid key", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/bulk`,
      payload: { variables: [{ key: "1INVALID", value: "x" }] }
    });

    assert.equal(response.statusCode, 400);
  });

  test("rejects duplicate keys within the same submission", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/bulk`,
      payload: {
        variables: [
          { key: "DUPLICATE", value: "1" },
          { key: "DUPLICATE", value: "2" }
        ]
      }
    });

    assert.equal(response.statusCode, 400);
    assert.equal(appDatabase.listAppEnvVars(appId).length, 0);
  });

  test("rejects an empty variable list", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/bulk`,
      payload: { variables: [] }
    });

    assert.equal(response.statusCode, 400);
  });

  test("returns 404 for an unknown app", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/apps/999999/environment/bulk`,
      payload: { variables: [{ key: "A", value: "1" }] }
    });

    assert.equal(response.statusCode, 404);
  });
});
