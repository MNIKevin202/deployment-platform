import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildWebhookPayload,
  formatDeployMessage,
  notifyDeployEvent,
  sendNotification,
  shouldNotify,
  type FetchImpl,
  type NotificationConfig
} from "../services/notification-service.js";

describe("notification-service", () => {
  test("shouldNotify only matches deploy-outcome events", () => {
    assert.equal(shouldNotify("github-deploy-succeeded"), true);
    assert.equal(shouldNotify("github-deploy-failed"), true);
    assert.equal(shouldNotify("revert-succeeded"), true);
    assert.equal(shouldNotify("github-deploy-progress"), false);
    assert.equal(shouldNotify("health-became-healthy"), false);
  });

  test("formats a message with a status emoji", () => {
    assert.match(formatDeployMessage({ eventType: "github-deploy-succeeded", message: "deployed X" }), /^✅ deployed X$/);
    assert.match(formatDeployMessage({ eventType: "github-deploy-failed", message: "boom" }), /^❌ boom$/);
  });

  test("builds the right payload per webhook flavor", () => {
    assert.deepEqual(buildWebhookPayload("discord", "hi"), { content: "hi" });
    assert.deepEqual(buildWebhookPayload("slack", "hi"), { text: "hi" });
    assert.deepEqual(buildWebhookPayload("generic", "hi"), { text: "hi" });
  });

  test("sendNotification rejects a non-http URL without calling fetch", async () => {
    let called = false;
    const fetchImpl: FetchImpl = async () => {
      called = true;
      return { ok: true, status: 200 };
    };
    const config: NotificationConfig = { enabled: true, type: "discord", webhookUrl: "not-a-url" };
    const result = await sendNotification(config, "hi", fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(called, false);
  });

  test("sendNotification posts and surfaces an HTTP error", async () => {
    const okConfig: NotificationConfig = { enabled: true, type: "slack", webhookUrl: "https://example.com/hook" };
    assert.equal((await sendNotification(okConfig, "hi", async () => ({ ok: true, status: 204 }))).ok, true);
    const bad = await sendNotification(okConfig, "hi", async () => ({ ok: false, status: 500 }));
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /HTTP 500/);
  });

  test("notifyDeployEvent no-ops when disabled or the event isn't notable", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    };
    const enabled: NotificationConfig = { enabled: true, type: "discord", webhookUrl: "https://example.com/h" };

    await notifyDeployEvent({ ...enabled, enabled: false }, { eventType: "github-deploy-succeeded", message: "x" }, fetchImpl);
    await notifyDeployEvent(enabled, { eventType: "github-deploy-progress", message: "x" }, fetchImpl);
    assert.deepEqual(calls, []);

    await notifyDeployEvent(enabled, { eventType: "github-deploy-succeeded", message: "x" }, fetchImpl);
    assert.deepEqual(calls, ["https://example.com/h"]);
  });
});
