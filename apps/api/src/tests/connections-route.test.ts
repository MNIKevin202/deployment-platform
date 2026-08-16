import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { registerConnectionRoutes } from "../routes/connections.js";

const ATLAS = "mongodb+srv://appuser:s3cr3t@cluster0.ab12c.mongodb.net/?retryWrites=true";

describe("connections routes", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let app: FastifyInstance;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-connections-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);

    app = Fastify({ logger: false });
    await registerConnectionRoutes(app, { appDatabase });
  });

  afterEach(async () => {
    await app.close();
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createAtlas() {
    return app.inject({
      method: "POST",
      url: "/connections",
      payload: {
        name: "Atlas — Production",
        kind: "mongodb",
        connectionString: ATLAS,
        envKey: "MONGODB_URI"
      }
    });
  }

  test("creates a connection and never returns the raw string in the response", async () => {
    const response = await createAtlas();
    assert.equal(response.statusCode, 201);

    const body = response.json() as {
      success: boolean;
      connection: { id: number; name: string; preview: string; envKey: string; inGlobalEnv: boolean };
    };
    assert.equal(body.success, true);
    assert.equal(body.connection.envKey, "MONGODB_URI");
    assert.equal(body.connection.inGlobalEnv, false);
    assert.ok(!body.connection.preview.includes("s3cr3t"));
    assert.match(body.connection.preview, /appuser:••••@/);
  });

  test("lists connections with a redacted preview only", async () => {
    await createAtlas();
    const response = await app.inject({ method: "GET", url: "/connections" });
    assert.equal(response.statusCode, 200);

    const body = response.json() as {
      connections: { preview: string }[];
    };
    assert.equal(body.connections.length, 1);
    assert.ok(!JSON.stringify(body.connections).includes("s3cr3t"));
  });

  test("reveal returns the full connection string", async () => {
    const created = (await createAtlas()).json() as { connection: { id: number } };
    const response = await app.inject({
      method: "GET",
      url: `/connections/${created.connection.id}/reveal`
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { connectionString: string };
    assert.equal(body.connectionString, ATLAS);
  });

  test("push-to-global creates a secret global variable every app inherits", async () => {
    const created = (await createAtlas()).json() as { connection: { id: number } };
    const response = await app.inject({
      method: "POST",
      url: `/connections/${created.connection.id}/push-to-global`
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { key: string; created: boolean };
    assert.equal(body.key, "MONGODB_URI");
    assert.equal(body.created, true);

    const stored = appDatabase.getGlobalEnvVarByKey("MONGODB_URI");
    assert.equal(stored?.value, ATLAS);
    assert.equal(stored?.isSecret, true);
    assert.equal(stored?.enabled, true);
  });

  test("push-to-global is idempotent — updates the value in place on a second push", async () => {
    const created = (await createAtlas()).json() as { connection: { id: number } };
    await app.inject({ method: "POST", url: `/connections/${created.connection.id}/push-to-global` });

    await app.inject({
      method: "PUT",
      url: `/connections/${created.connection.id}`,
      payload: { connectionString: "mongodb+srv://appuser:rotated@cluster0.ab12c.mongodb.net/" }
    });

    const second = await app.inject({
      method: "POST",
      url: `/connections/${created.connection.id}/push-to-global`
    });
    assert.equal((second.json() as { created: boolean }).created, false);

    const globals = appDatabase.listGlobalEnvVars().filter((v) => v.key === "MONGODB_URI");
    assert.equal(globals.length, 1);
    assert.equal(globals[0].value, "mongodb+srv://appuser:rotated@cluster0.ab12c.mongodb.net/");
  });

  test("a pushed connection reports inGlobalEnv on subsequent lists", async () => {
    const created = (await createAtlas()).json() as { connection: { id: number } };
    await app.inject({ method: "POST", url: `/connections/${created.connection.id}/push-to-global` });

    const list = (await app.inject({ method: "GET", url: "/connections" })).json() as {
      connections: { inGlobalEnv: boolean }[];
    };
    assert.equal(list.connections[0].inGlobalEnv, true);
  });

  test("push-to-global is rejected when the connection has no variable name", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/connections",
        payload: { name: "Copy only", kind: "other", connectionString: ATLAS, envKey: "" }
      })
    ).json() as { connection: { id: number; envKey: string | null } };
    assert.equal(created.connection.envKey, null);

    const response = await app.inject({
      method: "POST",
      url: `/connections/${created.connection.id}/push-to-global`
    });
    assert.equal(response.statusCode, 400);
  });

  test("editing without a connection string keeps the stored secret", async () => {
    const created = (await createAtlas()).json() as { connection: { id: number } };
    await app.inject({
      method: "PUT",
      url: `/connections/${created.connection.id}`,
      payload: { name: "Atlas — Prod (renamed)" }
    });

    const revealed = (
      await app.inject({ method: "GET", url: `/connections/${created.connection.id}/reveal` })
    ).json() as { connectionString: string };
    assert.equal(revealed.connectionString, ATLAS);
  });

  test("rejects an invalid variable name", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/connections",
      payload: { name: "Bad", kind: "mongodb", connectionString: ATLAS, envKey: "1BAD KEY" }
    });
    assert.equal(response.statusCode, 400);
  });

  test("delete removes the connection", async () => {
    const created = (await createAtlas()).json() as { connection: { id: number } };
    const del = await app.inject({
      method: "DELETE",
      url: `/connections/${created.connection.id}`
    });
    assert.equal(del.statusCode, 200);
    assert.equal(appDatabase.listConnections().length, 0);
  });

  test("returns 404 for an unknown connection", async () => {
    const response = await app.inject({ method: "GET", url: "/connections/999999/reveal" });
    assert.equal(response.statusCode, 404);
  });
});
