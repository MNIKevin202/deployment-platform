import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "resolve-update.mjs");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY_ID = "test-signing-key";

function baseManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    version: "1.2.0",
    channel: "stable",
    releasedAt: "2026-09-16T20:00:00.000Z",
    sourceCommit: "a".repeat(40),
    api: { repository: "ghcr.io/owner/clovaforge-api", digest: `sha256:${"b".repeat(64)}` },
    web: { repository: "ghcr.io/owner/clovaforge-web", digest: `sha256:${"c".repeat(64)}` },
    minimumUpgradeVersion: "1.0.0",
    requiresManualApproval: false,
    ...overrides
  };
}

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clovaforge-resolve-"));
  mkdirSync(join(dir, "keys"));
  writeFileSync(join(dir, "keys", `${KEY_ID}.pem`), publicKey.export({ type: "spki", format: "pem" }).toString());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes manifest+signature+context and runs the resolver, returning the parsed decision. */
function resolve(context, { manifest = baseManifest(), sign = true, keyId = KEY_ID, tamper = false } = {}) {
  const manifestJson = JSON.stringify(manifest);
  writeFileSync(join(dir, "manifest.json"), tamper ? manifestJson.replace("1.2.0", "9.9.9") : manifestJson);
  const signature = sign ? edSign(null, Buffer.from(manifestJson, "utf8"), privateKey).toString("base64") : "AAAA";
  writeFileSync(join(dir, "manifest.json.sig"), JSON.stringify({ signature, keyId }));
  const fullContext = {
    manifestPath: join(dir, "manifest.json"),
    signaturePath: join(dir, "manifest.json.sig"),
    trustedKeysDir: join(dir, "keys"),
    ...context
  };
  writeFileSync(join(dir, "context.json"), JSON.stringify(fullContext));
  const out = execFileSync("node", [SCRIPT, join(dir, "context.json")], { encoding: "utf8" });
  return JSON.parse(out.trim());
}

describe("resolve-update: security / verification", () => {
  test("a valid signed newer release under 'automatic' resolves to apply", () => {
    const d = resolve({ currentVersion: "1.1.0", channel: "stable", policy: "automatic" });
    assert.equal(d.action, "apply");
    assert.equal(d.targetVersion, "1.2.0");
    assert.equal(d.apiDigest, `sha256:${"b".repeat(64)}`);
  });

  test("a tampered manifest (bytes != signature) is rejected", () => {
    const d = resolve({ currentVersion: "1.1.0", channel: "stable", policy: "automatic" }, { tamper: true });
    assert.equal(d.action, "none");
    assert.equal(d.reason, "signature-verification-failed");
  });

  test("an unknown signing key is rejected", () => {
    const d = resolve({ currentVersion: "1.1.0", channel: "stable", policy: "automatic" }, { keyId: "attacker-key" });
    assert.equal(d.action, "none");
    assert.equal(d.reason, "unknown-signing-key");
  });

  test("an invalid signature is rejected", () => {
    const d = resolve({ currentVersion: "1.1.0", channel: "stable", policy: "automatic" }, { sign: false });
    assert.equal(d.action, "none");
    assert.equal(d.reason, "signature-verification-failed");
  });

  test("a manifest failing schema validation is rejected", () => {
    const d = resolve(
      { currentVersion: "1.1.0", channel: "stable", policy: "automatic" },
      { manifest: baseManifest({ api: { repository: "x", digest: "not-a-digest" } }) }
    );
    assert.equal(d.action, "none");
    assert.equal(d.reason, "invalid-manifest");
  });
});

describe("resolve-update: version logic", () => {
  test("same version is up-to-date (no action)", () => {
    const d = resolve({ currentVersion: "1.2.0", channel: "stable", policy: "automatic" });
    assert.equal(d.action, "none");
    assert.equal(d.reason, "up-to-date");
  });

  test("older-than-minimum requires incremental upgrade (notify, not apply)", () => {
    const d = resolve(
      { currentVersion: "0.5.0", channel: "stable", policy: "automatic" },
      { manifest: baseManifest({ version: "2.0.0", minimumUpgradeVersion: "1.0.0" }) }
    );
    assert.equal(d.action, "notify");
    assert.equal(d.reason, "incremental-upgrade-required");
  });

  test("compares numerically, not lexicographically", () => {
    // Lexicographically "1.9.0" > "1.10.0", so a string comparison would
    // wrongly treat 1.9.0 as newer than the installed 1.10.0 and try to
    // "upgrade" (downgrade). Numeric comparison correctly says up-to-date.
    const d = resolve(
      { currentVersion: "1.10.0", channel: "stable", policy: "automatic" },
      { manifest: baseManifest({ version: "1.9.0" }) }
    );
    assert.equal(d.action, "none");
    assert.equal(d.reason, "up-to-date");
  });
});

describe("resolve-update: policy gates", () => {
  test("notify_only never applies", () => {
    const d = resolve({ currentVersion: "1.1.0", channel: "stable", policy: "notify_only" });
    assert.equal(d.action, "notify");
    assert.equal(d.reason, "policy-notify-only");
  });

  test("automatic_patch applies a patch, notifies on a minor", () => {
    const patch = resolve(
      { currentVersion: "1.2.0", channel: "stable", policy: "automatic_patch" },
      { manifest: baseManifest({ version: "1.2.1" }) }
    );
    assert.equal(patch.action, "apply");
    const minor = resolve(
      { currentVersion: "1.2.0", channel: "stable", policy: "automatic_patch" },
      { manifest: baseManifest({ version: "1.3.0" }) }
    );
    assert.equal(minor.action, "notify");
    assert.equal(minor.reason, "minor-requires-manual-under-patch-policy");
  });

  test("a major upgrade never auto-applies, even under 'automatic'", () => {
    const d = resolve(
      { currentVersion: "1.2.0", channel: "stable", policy: "automatic" },
      { manifest: baseManifest({ version: "2.0.0", minimumUpgradeVersion: "1.0.0" }) }
    );
    assert.equal(d.action, "notify");
    assert.equal(d.reason, "major-requires-manual");
  });

  test("requiresManualApproval blocks automatic apply", () => {
    const d = resolve(
      { currentVersion: "1.1.0", channel: "stable", policy: "automatic" },
      { manifest: baseManifest({ requiresManualApproval: true }) }
    );
    assert.equal(d.action, "notify");
    assert.equal(d.reason, "manual-approval-required");
  });
});

describe("resolve-update: maintenance window", () => {
  test("outside the window, an otherwise-eligible auto-update only notifies", () => {
    const d = resolve({
      currentVersion: "1.1.0",
      channel: "stable",
      policy: "automatic",
      now: "2026-09-16T12:00:00Z",
      maintenanceWindow: { start: "01:00", end: "05:00", timezone: "UTC" }
    });
    assert.equal(d.action, "notify");
    assert.equal(d.reason, "outside-maintenance-window");
  });

  test("inside the window, it applies", () => {
    const d = resolve({
      currentVersion: "1.1.0",
      channel: "stable",
      policy: "automatic",
      now: "2026-09-16T03:30:00Z",
      maintenanceWindow: { start: "01:00", end: "05:00", timezone: "UTC" }
    });
    assert.equal(d.action, "apply");
  });
});

describe("resolve-update: manual override + channel", () => {
  test("a pending manual apply bypasses policy and window", () => {
    const d = resolve({
      currentVersion: "1.1.0",
      channel: "stable",
      policy: "notify_only",
      now: "2026-09-16T12:00:00Z",
      maintenanceWindow: { start: "01:00", end: "05:00", timezone: "UTC" },
      pendingApply: { targetVersion: "1.2.0", trigger: "manual" }
    });
    assert.equal(d.action, "apply");
    assert.equal(d.trigger, "manual");
    assert.equal(d.reason, "operator-requested");
  });

  test("a manual apply satisfies requiresManualApproval", () => {
    const d = resolve(
      {
        currentVersion: "1.1.0",
        channel: "stable",
        policy: "notify_only",
        pendingApply: { targetVersion: "1.2.0", trigger: "manual" }
      },
      { manifest: baseManifest({ requiresManualApproval: true }) }
    );
    assert.equal(d.action, "apply");
  });

  test("a stable install rejects a higher-channel (beta) manifest", () => {
    const d = resolve(
      { currentVersion: "1.1.0", channel: "stable", policy: "automatic" },
      { manifest: baseManifest({ channel: "beta" }) }
    );
    assert.equal(d.action, "none");
    assert.equal(d.reason, "channel-mismatch");
  });

  test("a beta install accepts a stable-promoted manifest (stable ⊆ beta)", () => {
    const d = resolve(
      { currentVersion: "1.1.0", channel: "beta", policy: "automatic" },
      { manifest: baseManifest({ channel: "stable" }) }
    );
    assert.equal(d.action, "apply");
  });
});
