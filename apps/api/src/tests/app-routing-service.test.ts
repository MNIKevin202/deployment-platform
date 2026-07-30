import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createAppDatabase, type AppDatabase } from "../database.js";
import { updateAppRouting } from "../services/app-routing-service.js";
import type { RecordEventInput } from "../services/deployment-event-service.js";

describe("updateAppRouting", () => {
  let tempDir: string;
  let appDatabase: AppDatabase;
  let appId: number;
  let recordedEvents: RecordEventInput[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-routing-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    appDatabase = createAppDatabase(dbPath);

    const created = appDatabase.createApp({
      name: "demo",
      image: "demo:latest",
      containerPort: 3000,
      containerName: "demo",
      domain: "demo.apps.example.com"
    });
    appId = created.id;
    recordedEvents = [];
  });

  afterEach(() => {
    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<{ reconcileSucceeds: boolean }> = {}) {
    return {
      appDatabase,
      reconcileRouting: async () => ({
        lastReconcileSucceeded: overrides.reconcileSucceeds ?? true,
        lastError: overrides.reconcileSucceeds === false ? "caddy unreachable" : null
      }),
      recordEvent: (input: RecordEventInput) => {
        recordedEvents.push(input);
      }
    };
  }

  test("sets a custom domain on a public app", async () => {
    const result = await updateAppRouting(deps(), appId, {
      internalOnly: false,
      customDomain: "example.com"
    });

    assert.equal(result.success, true);
    assert.equal(result.domain, "example.com");
    assert.equal(result.internalOnly, false);
    assert.equal(appDatabase.getAppById(appId)?.domain, "example.com");
    assert.ok(recordedEvents.some((e) => e.eventType === "routing-changed"));
  });

  test("clears a custom domain back to the generated default", async () => {
    const baseline = await updateAppRouting(deps(), appId, { internalOnly: false });
    const generatedDomain = baseline.domain;
    assert.ok(generatedDomain);

    await updateAppRouting(deps(), appId, { internalOnly: false, customDomain: "example.com" });
    assert.equal(appDatabase.getAppById(appId)?.domain, "example.com");

    const result = await updateAppRouting(deps(), appId, { internalOnly: false });

    assert.equal(result.success, true);
    assert.equal(result.domain, generatedDomain);
    assert.notEqual(result.domain, "example.com");
  });

  test("switches a public app to internal-only, clearing its domain", async () => {
    const result = await updateAppRouting(deps(), appId, { internalOnly: true });

    assert.equal(result.success, true);
    assert.equal(result.domain, null);
    assert.equal(result.internalOnly, true);
    assert.equal(appDatabase.getAppById(appId)?.domain, null);
    assert.equal(appDatabase.getAppById(appId)?.internalOnly, true);
  });

  test("switches an internal-only app back to public with a custom domain", async () => {
    await updateAppRouting(deps(), appId, { internalOnly: true });

    const result = await updateAppRouting(deps(), appId, {
      internalOnly: false,
      customDomain: "example.com"
    });

    assert.equal(result.success, true);
    assert.equal(result.domain, "example.com");
    assert.equal(result.internalOnly, false);
  });

  test("rejects a domain already assigned to another app", async () => {
    const other = appDatabase.createApp({
      name: "other",
      image: "other:latest",
      containerPort: 3001,
      containerName: "other",
      domain: "taken.example.com"
    });

    const result = await updateAppRouting(deps(), appId, {
      internalOnly: false,
      customDomain: "taken.example.com"
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 409);
    // Nothing was written — the original app's domain is untouched.
    assert.equal(appDatabase.getAppById(appId)?.domain, "demo.apps.example.com");
    assert.equal(appDatabase.getAppById(other.id)?.domain, "taken.example.com");
  });

  test("rejects internalOnly combined with a customDomain", async () => {
    const result = await updateAppRouting(deps(), appId, {
      internalOnly: true,
      customDomain: "example.com"
    });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 400);
    assert.equal(appDatabase.getAppById(appId)?.domain, "demo.apps.example.com");
  });

  test("returns 404 for an unknown app", async () => {
    const result = await updateAppRouting(deps(), 999999, { internalOnly: false });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 404);
  });

  test("refuses to change routing for the platform's own reserved containers", async () => {
    const platformApp = appDatabase.createApp({
      name: "self",
      image: "n/a",
      containerPort: 1,
      containerName: "deployment-platform-api"
    });

    const result = await updateAppRouting(deps(), platformApp.id, { internalOnly: true });

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 400);
  });

  test("still applies the domain change and reports a warning when reconciliation fails", async () => {
    const result = await updateAppRouting(deps({ reconcileSucceeds: false }), appId, {
      internalOnly: false,
      customDomain: "example.com"
    });

    assert.equal(result.success, true);
    assert.equal(result.domain, "example.com");
    assert.match(result.message, /routing could not be updated/);
    assert.equal(appDatabase.getAppById(appId)?.domain, "example.com");
    assert.ok(recordedEvents.some((e) => e.eventType === "routing-warning"));
  });
});
