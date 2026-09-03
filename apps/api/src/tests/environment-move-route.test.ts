import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { registerEnvironmentRoutes } from "../routes/environment.js";

describe("POST /apps/:id/environment/move", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let app: FastifyInstance;
  let appId: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-env-move-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
    appId = appDatabase.createApp({
      name: "demo",
      image: "demo:latest",
      containerPort: 3000,
      containerName: "demo"
    }).id;
    app = Fastify({ logger: false });
    await registerEnvironmentRoutes(app, { appDatabase });
  });

  afterEach(async () => {
    await app.close();
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const move = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/apps/${appId}/environment/move`, payload: body });

  test("global → app, disable: copies value+secret to the app and disables the global", async () => {
    appDatabase.createGlobalEnvVar({ key: "API_KEY", value: "s3cr3t", isSecret: true, enabled: true });

    const response = await move({ direction: "global-to-app", key: "API_KEY", disposition: "disable" });
    assert.equal(response.statusCode, 200);

    const appVar = appDatabase.getAppEnvVarByKey(appId, "API_KEY");
    assert.equal(appVar?.value, "s3cr3t");
    assert.equal(appVar?.isSecret, true);
    assert.equal(appVar?.enabled, true);

    const globalVar = appDatabase.getGlobalEnvVarByKey("API_KEY");
    assert.equal(globalVar?.enabled, false, "global should be disabled, not deleted");
    assert.equal(globalVar?.value, "s3cr3t");
  });

  test("global → app, delete: removes the global", async () => {
    appDatabase.createGlobalEnvVar({ key: "TOKEN", value: "abc", isSecret: false, enabled: true });

    await move({ direction: "global-to-app", key: "TOKEN", disposition: "delete" });

    assert.equal(appDatabase.getAppEnvVarByKey(appId, "TOKEN")?.value, "abc");
    assert.equal(appDatabase.getGlobalEnvVarByKey("TOKEN"), null);
  });

  test("app → global, disable: copies to global and disables the app var", async () => {
    appDatabase.createAppEnvVar({ appId, key: "SHARED", value: "v1", isSecret: true, enabled: true });

    const response = await move({ direction: "app-to-global", key: "SHARED", disposition: "disable" });
    assert.equal(response.statusCode, 200);

    const globalVar = appDatabase.getGlobalEnvVarByKey("SHARED");
    assert.equal(globalVar?.value, "v1");
    assert.equal(globalVar?.isSecret, true);

    const appVar = appDatabase.getAppEnvVarByKey(appId, "SHARED");
    assert.equal(appVar?.enabled, false, "app var should be disabled, not deleted");
  });

  test("app → global, delete: removes the app var", async () => {
    appDatabase.createAppEnvVar({ appId, key: "PROMOTE_ME", value: "x", isSecret: false, enabled: true });

    await move({ direction: "app-to-global", key: "PROMOTE_ME", disposition: "delete" });

    assert.equal(appDatabase.getGlobalEnvVarByKey("PROMOTE_ME")?.value, "x");
    assert.equal(appDatabase.getAppEnvVarByKey(appId, "PROMOTE_ME"), null);
  });

  test("global → app overwrites an existing app var of the same key instead of duplicating", async () => {
    appDatabase.createGlobalEnvVar({ key: "K", value: "from-global", isSecret: false, enabled: true });
    appDatabase.createAppEnvVar({ appId, key: "K", value: "old-app-value", isSecret: false, enabled: true });

    await move({ direction: "global-to-app", key: "K", disposition: "disable" });

    const appVars = appDatabase.listAppEnvVars(appId).filter((v) => v.key === "K");
    assert.equal(appVars.length, 1);
    assert.equal(appVars[0].value, "from-global");
  });

  test("marks environments as touched so apps redeploy to pick up the change", async () => {
    appDatabase.createGlobalEnvVar({ key: "K", value: "v", isSecret: false, enabled: true });
    assert.equal(appDatabase.getAppById(appId)?.environmentTouchedAt, null);

    await move({ direction: "global-to-app", key: "K", disposition: "delete" });

    assert.notEqual(appDatabase.getAppById(appId)?.environmentTouchedAt, null);
  });

  test("404 when the source variable does not exist", async () => {
    const missingGlobal = await move({ direction: "global-to-app", key: "NOPE", disposition: "disable" });
    assert.equal(missingGlobal.statusCode, 404);

    const missingApp = await move({ direction: "app-to-global", key: "NOPE", disposition: "disable" });
    assert.equal(missingApp.statusCode, 404);
  });

  test("rejects an invalid direction or disposition", async () => {
    appDatabase.createGlobalEnvVar({ key: "K", value: "v", isSecret: false, enabled: true });
    assert.equal((await move({ direction: "sideways", key: "K", disposition: "disable" })).statusCode, 400);
    assert.equal((await move({ direction: "global-to-app", key: "K", disposition: "vaporize" })).statusCode, 400);
  });
});
