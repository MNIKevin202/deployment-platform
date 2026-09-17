#!/usr/bin/env node
/**
 * resolve-update.mjs — the self-updater's verify-and-decide step.
 *
 * Given a downloaded release manifest + detached signature, the trusted
 * public keys, and the installation's own context (current version, channel,
 * policy, maintenance window, any pending manual apply request), this decides
 * ONE thing: what the host updater should do this tick — "apply", "notify",
 * or "none" — and, for an apply, the exact digest-pinned images to pull.
 *
 * Deliberately self-contained (only node:crypto/fs): it must run without any
 * ClovaForge source, without npm, and — critically — without depending on the
 * currently-installed image being new enough to contain this logic. That is
 * exactly the first-bootstrap case, and an updater that needed the thing it's
 * replacing to already be new would be unable to perform the first update.
 *
 * It is the security boundary: it verifies the Ed25519 signature over the
 * manifest's exact bytes against the trusted keys before trusting a single
 * field. A manifest that fails verification, schema checks, the
 * minimum-upgrade-version floor, or a downgrade check yields action "none"
 * with a reason — never "apply". Rollback safety is NOT decided here (it
 * depends on the target image's own migration classifications and is computed
 * by the host after the image is pulled); this step only gets us to the point
 * of a trustworthy decision to pull.
 *
 * Usage:  node resolve-update.mjs <context.json>
 * Output: a single line of JSON (the decision) on stdout; exit 0 always
 *         unless the context itself is unusable (exit 1). "do nothing" is a
 *         normal, successful outcome, not an error.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { join } from "node:path";

function die(message) {
  process.stderr.write(`resolve-update: ${message}\n`);
  process.exit(1);
}

function emit(decision) {
  process.stdout.write(JSON.stringify(decision) + "\n");
  process.exit(0);
}

// ---- semver (strict MAJOR.MINOR.PATCH, mirrors apps/api/src/services/semver.ts) ----
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
function parseSemver(v) {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}
function cmp(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error("invalid semver in comparison");
  if (x.major !== y.major) return x.major < y.major ? -1 : 1;
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1;
  return 0;
}
function isPatchOnly(from, to) {
  const a = parseSemver(from);
  const b = parseSemver(to);
  return a.major === b.major && a.minor === b.minor && b.patch > a.patch;
}
function isMajorUpgrade(from, to) {
  return parseSemver(to).major > parseSemver(from).major;
}

// ---- maintenance window (mirrors apps/api/src/services/update-policy.ts) ----
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function toMinutes(hhmm) {
  const m = HHMM.exec(hhmm);
  return +m[1] * 60 + +m[2];
}
function minutesInZone(now, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  let hour = +(parts.find((p) => p.type === "hour")?.value ?? "0");
  if (hour === 24) hour = 0;
  const minute = +(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}
function withinWindow(window, now) {
  if (!window) return true;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === end) return false;
  const cur = minutesInZone(now, window.timezone);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

// ---- trusted keys ----
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
function loadKeys(dir) {
  const keys = {};
  if (!dir || !existsSync(dir)) return keys;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".pem")) continue;
    const id = entry.slice(0, -4);
    if (!KEY_ID.test(id)) continue;
    try {
      const pem = readFileSync(join(dir, entry), "utf8").trim();
      if (pem.includes("BEGIN PUBLIC KEY")) keys[id] = pem;
    } catch {
      /* skip unreadable */
    }
  }
  return keys;
}

function verifySignature(rawManifestBytes, signatureBase64, keyId, trustedKeys) {
  const pem = trustedKeys[keyId];
  if (!pem) return false;
  try {
    return edVerify(null, Buffer.from(rawManifestBytes, "utf8"), createPublicKey(pem), Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

// ---- manifest validation (mirrors apps/api/src/schemas/release-manifest.ts, minimal but strict) ----
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const CHANNELS = ["stable", "beta", "nightly"];
function validateManifest(m) {
  if (typeof m !== "object" || m === null) return "not an object";
  if (m.schemaVersion !== 1) return "unsupported schemaVersion";
  if (!SEMVER.test(m.version)) return "invalid version";
  if (!CHANNELS.includes(m.channel)) return "invalid channel";
  if (!COMMIT.test(m.sourceCommit)) return "invalid sourceCommit";
  if (!SEMVER.test(m.minimumUpgradeVersion)) return "invalid minimumUpgradeVersion";
  for (const part of ["api", "web"]) {
    const ref = m[part];
    if (typeof ref !== "object" || ref === null) return `missing ${part} image ref`;
    if (typeof ref.repository !== "string" || ref.repository.length === 0) return `invalid ${part} repository`;
    if (!DIGEST.test(ref.digest)) return `invalid ${part} digest`;
  }
  return null;
}

// ---- main ----
const contextPath = process.argv[2];
if (!contextPath) die("usage: resolve-update.mjs <context.json>");

let ctx;
try {
  ctx = JSON.parse(readFileSync(contextPath, "utf8"));
} catch (error) {
  die(`cannot read context: ${error.message}`);
}

const now = ctx.now ? new Date(ctx.now) : new Date();
const currentVersion = ctx.currentVersion;
if (!SEMVER.test(currentVersion || "")) {
  // "dev" or an unknown current version: never auto-update from an
  // unversioned build; only a bootstrap/manual path handles that.
  if (!(ctx.pendingApply && ctx.pendingApply.trigger === "bootstrap")) {
    emit({ action: "none", reason: "current-version-not-semver", currentVersion: currentVersion ?? null });
  }
}

let rawManifest;
let rawSignature;
try {
  rawManifest = readFileSync(ctx.manifestPath, "utf8");
  rawSignature = readFileSync(ctx.signaturePath, "utf8");
} catch (error) {
  emit({ action: "none", reason: "manifest-unreadable", detail: error.message });
}

let sigEnvelope;
try {
  sigEnvelope = JSON.parse(rawSignature);
} catch {
  emit({ action: "none", reason: "invalid-signature-envelope" });
}
if (!sigEnvelope || typeof sigEnvelope.signature !== "string" || typeof sigEnvelope.keyId !== "string") {
  emit({ action: "none", reason: "invalid-signature-envelope" });
}

const trustedKeys = loadKeys(ctx.trustedKeysDir);
if (!(sigEnvelope.keyId in trustedKeys)) {
  emit({ action: "none", reason: "unknown-signing-key", keyId: sigEnvelope.keyId });
}
if (!verifySignature(rawManifest, sigEnvelope.signature, sigEnvelope.keyId, trustedKeys)) {
  emit({ action: "none", reason: "signature-verification-failed" });
}

let manifest;
try {
  manifest = JSON.parse(rawManifest);
} catch {
  emit({ action: "none", reason: "invalid-json" });
}
const validationError = validateManifest(manifest);
if (validationError) {
  emit({ action: "none", reason: "invalid-manifest", detail: validationError });
}

// The manifest's declared channel must match what we asked for — a stable
// installation must never be handed a beta manifest even if it verifies.
if (ctx.channel && manifest.channel !== ctx.channel && !(ctx.pendingApply && ctx.pendingApply.trigger === "bootstrap")) {
  // Channel pointers may serve a release promoted to a lower channel (stable
  // ⊆ beta), so only reject a HIGHER channel than requested.
  const rank = { stable: 0, beta: 1, nightly: 2 };
  if ((rank[manifest.channel] ?? 99) > (rank[ctx.channel] ?? -1)) {
    emit({ action: "none", reason: "channel-mismatch", manifestChannel: manifest.channel, requested: ctx.channel });
  }
}

const target = manifest.version;
const isBootstrap = !!(ctx.pendingApply && ctx.pendingApply.trigger === "bootstrap");

// Not an upgrade (and not a bootstrap forcing a specific install): nothing to do.
if (!isBootstrap && SEMVER.test(currentVersion) && cmp(target, currentVersion) <= 0) {
  emit({ action: "none", reason: "up-to-date", currentVersion, latestVersion: target });
}

// Minimum-upgrade-version floor: too old to jump straight here.
if (!isBootstrap && SEMVER.test(currentVersion) && cmp(currentVersion, manifest.minimumUpgradeVersion) < 0) {
  emit({
    action: "notify",
    reason: "incremental-upgrade-required",
    currentVersion,
    latestVersion: target,
    minimumUpgradeVersion: manifest.minimumUpgradeVersion
  });
}

const applyPayload = {
  targetVersion: target,
  apiRepository: manifest.api.repository,
  apiDigest: manifest.api.digest,
  webRepository: manifest.web.repository,
  webDigest: manifest.web.digest,
  sourceCommit: manifest.sourceCommit,
  requiresManualApproval: manifest.requiresManualApproval === true
};

// A pending manual/bootstrap apply request for exactly this version: the
// operator asked, so bypass policy AND maintenance-window timing. A manual
// request IS the approval for a requiresManualApproval release.
if (ctx.pendingApply && ctx.pendingApply.targetVersion === target) {
  emit({ action: "apply", trigger: ctx.pendingApply.trigger, reason: "operator-requested", ...applyPayload });
}

// Otherwise, automatic path: policy + window gate it.
const policy = ctx.policy || "notify_only";

if (manifest.requiresManualApproval === true) {
  emit({ action: "notify", reason: "manual-approval-required", ...applyPayload });
}
if (policy === "notify_only") {
  emit({ action: "notify", reason: "policy-notify-only", ...applyPayload });
}
if (isMajorUpgrade(currentVersion, target)) {
  emit({ action: "notify", reason: "major-requires-manual", ...applyPayload });
}
if (policy === "automatic_patch" && !isPatchOnly(currentVersion, target)) {
  emit({ action: "notify", reason: "minor-requires-manual-under-patch-policy", ...applyPayload });
}
// policy allows this upgrade; now the maintenance window gates the timing.
if (!withinWindow(ctx.maintenanceWindow ?? null, now)) {
  emit({ action: "notify", reason: "outside-maintenance-window", ...applyPayload });
}

emit({ action: "apply", trigger: "automatic", reason: "policy-and-window-allow", ...applyPayload });
