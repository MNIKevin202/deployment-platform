import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  evaluateAutoApply,
  isMajorUpgrade,
  isValidMaintenanceWindow,
  isWithinMaintenanceWindow,
  type MaintenanceWindow
} from "../services/update-policy.js";

describe("isMajorUpgrade", () => {
  test("true only when the major component increases", () => {
    assert.equal(isMajorUpgrade("1.9.9", "2.0.0"), true);
    assert.equal(isMajorUpgrade("1.2.3", "1.3.0"), false);
    assert.equal(isMajorUpgrade("1.2.3", "1.2.4"), false);
    assert.equal(isMajorUpgrade("2.0.0", "1.9.9"), false);
  });
});

describe("evaluateAutoApply", () => {
  const base = { currentVersion: "1.2.3", requiresManualApproval: false };

  test("a non-upgrade is never auto-applied", () => {
    const result = evaluateAutoApply({ ...base, policy: "automatic", targetVersion: "1.2.3" });
    assert.equal(result.autoApplyAllowed, false);
    assert.equal(result.reason, "not-an-upgrade");
  });

  test("notify_only never auto-applies, even a patch", () => {
    const result = evaluateAutoApply({ ...base, policy: "notify_only", targetVersion: "1.2.4" });
    assert.equal(result.autoApplyAllowed, false);
    assert.equal(result.reason, "policy-notify-only");
  });

  test("requiresManualApproval blocks auto-apply under every policy", () => {
    for (const policy of ["automatic_patch", "automatic"] as const) {
      const result = evaluateAutoApply({
        ...base,
        policy,
        targetVersion: "1.2.4",
        requiresManualApproval: true
      });
      assert.equal(result.autoApplyAllowed, false, policy);
      assert.equal(result.reason, "manual-approval-required", policy);
    }
  });

  test("a major upgrade is never auto-applied, even under 'automatic'", () => {
    const result = evaluateAutoApply({ ...base, policy: "automatic", targetVersion: "2.0.0" });
    assert.equal(result.autoApplyAllowed, false);
    assert.equal(result.reason, "major-requires-manual");
  });

  test("automatic_patch applies a patch but not a minor", () => {
    const patch = evaluateAutoApply({ ...base, policy: "automatic_patch", targetVersion: "1.2.4" });
    assert.equal(patch.autoApplyAllowed, true);
    assert.equal(patch.reason, "allowed");

    const minor = evaluateAutoApply({ ...base, policy: "automatic_patch", targetVersion: "1.3.0" });
    assert.equal(minor.autoApplyAllowed, false);
    assert.equal(minor.reason, "minor-requires-manual-under-patch-policy");
  });

  test("automatic applies both patch and minor", () => {
    assert.equal(evaluateAutoApply({ ...base, policy: "automatic", targetVersion: "1.2.4" }).autoApplyAllowed, true);
    assert.equal(evaluateAutoApply({ ...base, policy: "automatic", targetVersion: "1.3.0" }).autoApplyAllowed, true);
  });
});

describe("isValidMaintenanceWindow", () => {
  test("accepts a well-formed window", () => {
    assert.equal(isValidMaintenanceWindow({ start: "01:00", end: "05:00", timezone: "UTC" }), true);
  });

  test("rejects malformed times and unknown timezones", () => {
    assert.equal(isValidMaintenanceWindow({ start: "1:00", end: "05:00", timezone: "UTC" }), false);
    assert.equal(isValidMaintenanceWindow({ start: "25:00", end: "05:00", timezone: "UTC" }), false);
    assert.equal(isValidMaintenanceWindow({ start: "01:00", end: "05:00", timezone: "Mars/Phobos" }), false);
    assert.equal(isValidMaintenanceWindow(null), false);
    assert.equal(isValidMaintenanceWindow("01:00-05:00"), false);
  });
});

describe("isWithinMaintenanceWindow", () => {
  // A fixed instant: 2026-09-16T03:30:00Z.
  const at = (iso: string) => new Date(iso);

  test("a null window is always open", () => {
    assert.equal(isWithinMaintenanceWindow(null, at("2026-09-16T12:00:00Z")), true);
  });

  test("same-day UTC window includes its start, excludes its end", () => {
    const window: MaintenanceWindow = { start: "01:00", end: "05:00", timezone: "UTC" };
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T01:00:00Z")), true, "at start");
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T03:30:00Z")), true, "inside");
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T05:00:00Z")), false, "at end (exclusive)");
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T00:59:00Z")), false, "before");
  });

  test("a window crossing midnight is open on both sides of 00:00", () => {
    const window: MaintenanceWindow = { start: "23:00", end: "02:00", timezone: "UTC" };
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T23:30:00Z")), true, "late evening");
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T01:00:00Z")), true, "after midnight");
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T12:00:00Z")), false, "midday closed");
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T02:00:00Z")), false, "at end (exclusive)");
  });

  test("start == end is a never-open window", () => {
    const window: MaintenanceWindow = { start: "03:00", end: "03:00", timezone: "UTC" };
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T03:00:00Z")), false);
  });

  test("respects the window's timezone, not the host's", () => {
    // 03:30 UTC is 23:30 the previous day in America/New_York (UTC-4 in Sept).
    const window: MaintenanceWindow = { start: "23:00", end: "23:59", timezone: "America/New_York" };
    assert.equal(isWithinMaintenanceWindow(window, at("2026-09-16T03:30:00Z")), true);
    // The same instant is NOT within a 23:00-23:59 UTC window.
    const utcWindow: MaintenanceWindow = { start: "23:00", end: "23:59", timezone: "UTC" };
    assert.equal(isWithinMaintenanceWindow(utcWindow, at("2026-09-16T03:30:00Z")), false);
  });
});
