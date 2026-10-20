import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { registerEnvironmentRoutes } from "../routes/environment.js";

// On-demand secret reveal: the list/lookup routes withhold a flagged secret's
// value (value: null), and these dedicated endpoints return the plaintext for
// one variable, reached only by an explicit "Show" action (inherits the
// platform's global admin session gate).
describe("environment variable reveal endpoints", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let app: FastifyInstance;
  let appId: number;
  let globalSecretId: number;
  let appSecretId: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "clovaforge-env-reveal-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
    appId = appDatabase.createApp({
      name: "demo",
      image: "demo:latest",
      containerPort: 3000,
      containerName: "demo"
    }).id;
    globalSecretId = appDatabase.createGlobalEnvVar({
      key: "API_KEY",
      value: "super-secret-global",
      isSecret: true,
      enabled: true
    }).id;
    appSecretId = appDatabase.createAppEnvVar({
      appId,
      key: "APP_TOKEN",
      value: "super-secret-app",
      isSecret: true,
      enabled: true
    }).id;

    app = Fastify({ logger: false });
    await registerEnvironmentRoutes(app, { appDatabase });
  });

  afterEach(async () => {
    await app.close();
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("the list route still withholds the secret value", async () => {
    const response = await app.inject({ method: "GET", url: "/environment/global" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.includes("super-secret-global"), false);
    const v = response.json().variables.find((x: { key: string }) => x.key === "API_KEY");
    assert.equal(v.value, null);
    assert.equal(v.hasValue, true);
  });

  test("global reveal returns the plaintext for one variable", async () => {
    const response = await app.inject({ method: "GET", url: `/environment/global/${globalSecretId}/reveal` });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.success, true);
    assert.equal(body.value, "super-secret-global");
  });

  test("global reveal 404s for an unknown id", async () => {
    const response = await app.inject({ method: "GET", url: "/environment/global/999999/reveal" });
    assert.equal(response.statusCode, 404);
  });

  test("app reveal returns the plaintext for one variable", async () => {
    const response = await app.inject({ method: "GET", url: `/apps/${appId}/environment/${appSecretId}/reveal` });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.success, true);
    assert.equal(body.value, "super-secret-app");
  });

  test("app reveal 404s when the variable belongs to a different app", async () => {
    const other = appDatabase.createApp({
      name: "other",
      image: "other:latest",
      containerPort: 3000,
      containerName: "other"
    }).id;
    const response = await app.inject({ method: "GET", url: `/apps/${other}/environment/${appSecretId}/reveal` });
    assert.equal(response.statusCode, 404);
  });

  test("app reveal 404s for an unknown app", async () => {
    const response = await app.inject({ method: "GET", url: `/apps/999999/environment/${appSecretId}/reveal` });
    assert.equal(response.statusCode, 404);
  });
});
