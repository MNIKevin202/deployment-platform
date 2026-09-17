import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { registerPlatformUpdateRoutes } from "../routes/platform-updates.js";
import type { ManifestResult } from "../services/release-manifest-service.js";

const VALID_SETTINGS = {
  channel: "stable",
  policy: "notify_only",
  manifestBaseUrl: "https://releases.example.com/download",
  maintenanceWindow: null
};

function upToDateResult(): ManifestResult {
  return {
    success: true,
    manifest: {
      schemaVersion: 1,
      version: "1.0.0",
      channel: "stable",
      releasedAt: "2026-09-16T20:00:00.000Z",
      sourceCommit: "a".repeat(40),
      api: { repository: "ghcr.io/owner/clovaforge-api", digest: `sha256:${"b".repeat(64)}` },
      web: { repository: "ghcr.io/owner/clovaforge-web", digest: `sha256:${"c".repeat(64)}` },
      minimumUpgradeVersion: "1.0.0",
      requiresManualApproval: false
    }
  };
}

function updateAvailableResult(version = "1.1.0", overrides: Record<string, unknown> = {}): ManifestResult {
  const base = upToDateResult();
  if (!base.success) throw new Error("unreachable");
  return { success: true, manifest: { ...base.manifest, version, ...overrides } };
}

describe("platform updates routes", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let app: FastifyInstance;
  let checkManifest: () => Promise<ManifestResult>;
  let capturedUrls: { manifestUrl: string; signatureUrl: string } | null;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "clovaforge-updates-test-"));
    appDatabase = createAppDatabase(join(tempDir, `${randomUUID()}.sqlite`));
    checkManifest = async () => upToDateResult();
    capturedUrls = null;

    app = Fastify({ logger: false });
    await registerPlatformUpdateRoutes(app, {
      appDatabase,
      currentVersion: "1.0.0",
      checkManifest: (manifestUrl, signatureUrl) => {
        capturedUrls = { manifestUrl, signatureUrl };
        return checkManifest();
      }
    });
  });

  afterEach(async () => {
    await app.close();
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function configure() {
    await app.inject({ method: "PUT", url: "/platform/updates/settings", payload: VALID_SETTINGS });
  }

  test("GET settings returns defaults and derived channel URLs", async () => {
    const response = await app.inject({ method: "GET", url: "/platform/updates/settings" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.settings.channel, "stable");
    assert.equal(body.settings.policy, "notify_only");
    assert.ok(body.derivedUrls.manifestUrl.endsWith("/stable-latest/manifest.json"));
    assert.ok(body.derivedUrls.signatureUrl.endsWith("/stable-latest/manifest.json.sig"));
  });

  test("PUT settings rejects a non-HTTPS base URL", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/platform/updates/settings",
      payload: { ...VALID_SETTINGS, manifestBaseUrl: "http://releases.example.com/download" }
    });
    assert.equal(response.statusCode, 400);
  });

  test("PUT settings rejects a malformed maintenance window and a bad timezone", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/platform/updates/settings",
      payload: { ...VALID_SETTINGS, maintenanceWindow: { start: "1:00", end: "05:00", timezone: "UTC" } }
    });
    assert.equal(bad.statusCode, 400);
    const badTz = await app.inject({
      method: "PUT",
      url: "/platform/updates/settings",
      payload: { ...VALID_SETTINGS, maintenanceWindow: { start: "01:00", end: "05:00", timezone: "Mars/Phobos" } }
    });
    assert.equal(badTz.statusCode, 400);
  });

  test("PUT then GET round-trips a valid window and derives beta URLs when channel switches", async () => {
    const window = { start: "01:00", end: "05:00", timezone: "America/New_York" };
    const put = await app.inject({
      method: "PUT",
      url: "/platform/updates/settings",
      payload: { ...VALID_SETTINGS, channel: "beta", maintenanceWindow: window }
    });
    assert.equal(put.statusCode, 200);
    const get = await app.inject({ method: "GET", url: "/platform/updates/settings" });
    const body = get.json();
    assert.deepEqual(body.settings.maintenanceWindow, window);
    assert.ok(body.derivedUrls.manifestUrl.endsWith("/beta-latest/manifest.json"));
  });

  test("check uses the configured channel's derived URLs", async () => {
    await configure();
    await app.inject({ method: "POST", url: "/platform/updates/check" });
    assert.ok(capturedUrls);
    assert.ok(capturedUrls!.manifestUrl.endsWith("/stable-latest/manifest.json"));
  });

  test("check reports up-to-date when the manifest equals current", async () => {
    await configure();
    checkManifest = async () => upToDateResult();
    const response = await app.inject({ method: "POST", url: "/platform/updates/check" });
    assert.equal(response.json().status.result.outcome, "up-to-date");
  });

  test("check reports update-available and auto-apply ineligible under notify_only", async () => {
    await configure();
    checkManifest = async () => updateAvailableResult("1.1.0");
    const response = await app.inject({ method: "POST", url: "/platform/updates/check" });
    const result = response.json().status.result;
    assert.equal(result.outcome, "update-available");
    assert.equal(result.latestVersion, "1.1.0");
    assert.equal(result.autoApplyEligible, false, "notify_only never auto-eligible");
    assert.equal(result.autoApplyReason, "policy-notify-only");
  });

  test("check marks a patch auto-eligible under automatic_patch", async () => {
    await app.inject({
      method: "PUT",
      url: "/platform/updates/settings",
      payload: { ...VALID_SETTINGS, policy: "automatic_patch" }
    });
    checkManifest = async () => updateAvailableResult("1.0.1");
    const response = await app.inject({ method: "POST", url: "/platform/updates/check" });
    assert.equal(response.json().status.result.autoApplyEligible, true);
  });

  test("check surfaces a verification failure without throwing", async () => {
    await configure();
    checkManifest = async () => ({ success: false, reason: "signature-verification-failed", detail: "bad signature" });
    const response = await app.inject({ method: "POST", url: "/platform/updates/check" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status.result.reason, "signature-verification-failed");
  });

  test("request-apply is refused (409) with no prior update-available check", async () => {
    const response = await app.inject({ method: "POST", url: "/platform/updates/request-apply" });
    assert.equal(response.statusCode, 409);
  });

  test("request-apply is refused when the target requires an incremental upgrade", async () => {
    await configure();
    checkManifest = async () => updateAvailableResult("2.0.0", { minimumUpgradeVersion: "1.5.0" });
    await app.inject({ method: "POST", url: "/platform/updates/check" });
    const response = await app.inject({ method: "POST", url: "/platform/updates/request-apply" });
    assert.equal(response.statusCode, 409);
  });

  test("request-apply records the exact verified version after a successful check", async () => {
    await configure();
    checkManifest = async () => updateAvailableResult("1.1.0");
    await app.inject({ method: "POST", url: "/platform/updates/check" });
    const response = await app.inject({ method: "POST", url: "/platform/updates/request-apply" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().targetVersion, "1.1.0");
  });

  test("status starts idle and history starts empty", async () => {
    const status = await app.inject({ method: "GET", url: "/platform/updates/status" });
    assert.equal(status.json().state.state, "idle");
    const history = await app.inject({ method: "GET", url: "/platform/updates/history" });
    assert.deepEqual(history.json().history, []);
  });

  test("history reflects recorded attempts, newest first", async () => {
    const id = appDatabase.startUpdateAttempt({
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      policy: "automatic",
      trigger: "automatic",
      startedAt: new Date().toISOString()
    });
    appDatabase.finishUpdateAttempt({
      id,
      finishedAt: new Date().toISOString(),
      result: "successful",
      healthResult: "passed"
    });
    const history = await app.inject({ method: "GET", url: "/platform/updates/history" });
    const rows = history.json().history;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "successful");
    assert.equal(rows[0].toVersion, "1.1.0");
  });
});
