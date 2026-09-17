import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { registerAuthentication, hashPassword } from "../auth.js";
import { registerPlatformUpdateRoutes } from "../routes/platform-updates.js";

// Proves the platform-update routes inherit the platform's single global
// session-auth gate (auth.ts onRequest hook) — there is no parallel auth model.
// The update routes are NOT in the publicPaths allowlist, so an unauthenticated
// caller (e.g. a browser with no session, a CSRF attempt from another origin
// whose SameSite=Strict cookie is not attached) is rejected with 401 BEFORE any
// handler runs; a logged-in admin passes through.
describe("platform updates routes — authentication gate", () => {
  const PASSWORD = "correct horse battery staple";
  let tempDir: string;
  let appDatabase: AppDatabase;
  let app: FastifyInstance;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["ADMIN_USERNAME", "ADMIN_PASSWORD_HASH", "SESSION_SECRET", "COOKIE_SECURE"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD_HASH = hashPassword(PASSWORD);
    process.env.SESSION_SECRET = "s".repeat(48);
    process.env.COOKIE_SECURE = "false";

    tempDir = mkdtempSync(join(tmpdir(), "clovaforge-updates-auth-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));

    app = Fastify({ logger: false });
    await registerAuthentication(app);
    await registerPlatformUpdateRoutes(app, {
      appDatabase,
      currentVersion: "1.0.0",
      // Never touch the network or a real socket in this test.
      checkManifest: async () => ({
        success: true,
        manifest: {
          schemaVersion: 1,
          version: "1.0.0",
          channel: "stable",
          releasedAt: "2026-09-16T20:00:00.000Z",
          sourceCommit: "a".repeat(40),
          api: { repository: "ghcr.io/o/clovaforge-api", digest: `sha256:${"b".repeat(64)}` },
          web: { repository: "ghcr.io/o/clovaforge-web", digest: `sha256:${"c".repeat(64)}` },
          minimumUpgradeVersion: "1.0.0",
          requiresManualApproval: false
        }
      }),
      triggerUpdateTick: async () => {}
    });
  });

  afterEach(async () => {
    await app.close();
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function login(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: PASSWORD }
    });
    assert.equal(response.statusCode, 200, "login should succeed");
    const setCookie = response.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(raw, "login must set a session cookie");
    return raw.split(";")[0];
  }

  test("unauthenticated POST /platform/updates/apply is rejected with 401", async () => {
    const response = await app.inject({ method: "POST", url: "/platform/updates/apply" });
    assert.equal(response.statusCode, 401);
  });

  test("unauthenticated POST /platform/updates/request-apply is rejected with 401", async () => {
    const response = await app.inject({ method: "POST", url: "/platform/updates/request-apply" });
    assert.equal(response.statusCode, 401);
  });

  test("unauthenticated GET /platform/updates/status is rejected with 401", async () => {
    const response = await app.inject({ method: "GET", url: "/platform/updates/status" });
    assert.equal(response.statusCode, 401);
  });

  test("a logged-in admin passes the gate (status is reachable, not 401)", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "GET",
      url: "/platform/updates/status",
      headers: { cookie }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().success, true);
  });

  test("a logged-in admin reaching /apply is gated by update state, not auth (409, never 401)", async () => {
    const cookie = await login();
    const response = await app.inject({ method: "POST", url: "/platform/updates/apply", headers: { cookie } });
    // No update available (fresh check returns up-to-date) → 409, proving the
    // request passed authentication and hit the real guard.
    assert.equal(response.statusCode, 409);
  });
});
