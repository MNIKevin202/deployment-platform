import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { hashPassword } from "../auth.js";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { registerEnvironmentRoutes } from "../routes/environment.js";

describe("password-gated environment export", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let app: FastifyInstance;
  let appId: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-env-export-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
    appId = appDatabase.createApp({
      name: "demo",
      image: "demo:latest",
      containerPort: 3000,
      containerName: "demo"
    }).id;
    appDatabase.createGlobalEnvVar({ key: "API_KEY", value: "hidden-global", isSecret: true, enabled: true });
    appDatabase.createGlobalEnvVar({ key: "PLAIN", value: "hello world", isSecret: false, enabled: true });
    appDatabase.createGlobalEnvVar({ key: "DISABLED", value: "skip-me", isSecret: true, enabled: false });
    appDatabase.createAppEnvVar({ appId, key: "API_KEY", value: "hidden-override", isSecret: true, enabled: true });
    appDatabase.createAppEnvVar({ appId, key: "APP_ONLY", value: "app value", isSecret: false, enabled: true });
    appDatabase.createAppEnvVar({ appId, key: "DISABLED_APP", value: "disabled value", isSecret: true, enabled: false });

    app = Fastify({ logger: false });
    await registerEnvironmentRoutes(app, {
      appDatabase,
      exportPasswordHash: hashPassword("export-password-123")
    });
  });

  afterEach(async () => {
    await app.close();
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("ordinary environment responses remain masked", async () => {
    const response = await app.inject({ method: "GET", url: "/environment/global" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.includes("hidden-global"), false);
  });

  test("rejects an incorrect export password without returning values", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/environment/global/export",
      payload: { password: "wrong-password" }
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.payload.includes("hidden-global"), false);
  });

  test("exports global secret values only after password verification", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/environment/global/export",
      payload: { password: "export-password-123" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().content, 'API_KEY=hidden-global\nPLAIN="hello world"');
  });

  test("app export returns the enabled effective environment with overrides", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/export`,
      payload: { password: "export-password-123" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().content, 'API_KEY=hidden-override\nAPP_ONLY="app value"\nPLAIN="hello world"');
    assert.equal(response.payload.includes("skip-me"), false);
  });

  test("copy source returns app-specific values after password verification", async () => {
    const rejected = await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/copy-source`,
      payload: { password: "wrong-password" }
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.payload.includes("hidden-override"), false);

    const response = await app.inject({
      method: "POST",
      url: `/apps/${appId}/environment/copy-source`,
      payload: { password: "export-password-123" }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().variables, [
      { key: "API_KEY", value: "hidden-override", isSecret: true, enabled: true },
      { key: "APP_ONLY", value: "app value", isSecret: false, enabled: true },
      { key: "DISABLED_APP", value: "disabled value", isSecret: true, enabled: false }
    ]);
    assert.equal(response.payload.includes("hello world"), false);
  });
});
