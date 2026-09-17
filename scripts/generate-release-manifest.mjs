#!/usr/bin/env node
/**
 * Generates and signs a ClovaForge release manifest — the artifact
 * .github/workflows/release.yml publishes for installed instances to
 * discover and verify. See docs/SELF_UPDATE_ARCHITECTURE.md.
 *
 * Deliberately dependency-free (only node:crypto/fs/process) so it needs no
 * `npm ci` step of its own inside the release job beyond what already ran
 * for the build — matching this repo's existing convention of small,
 * self-contained helper scripts (see installer/lib/secrets.sh,
 * scripts/release-remote.sh's Node helpers) rather than adding a package
 * dependency for something this small and security-sensitive.
 *
 * Every field's shape here MUST match apps/api/src/schemas/release-manifest.ts
 * exactly — that file is the single source of truth for the shape; this
 * script does not re-derive or duplicate its validation rules, only
 * produces data meant to satisfy them (the release workflow validates the
 * output against that schema in a later step, via a tiny throwaway import).
 *
 * Usage (all via environment variables, never argv — see note below):
 *   RELEASE_VERSION=1.2.0 \
 *   RELEASE_CHANNEL=stable \
 *   SOURCE_COMMIT=<40-char sha> \
 *   API_IMAGE_REPOSITORY=ghcr.io/owner/clovaforge-api \
 *   API_IMAGE_DIGEST=sha256:... \
 *   WEB_IMAGE_REPOSITORY=ghcr.io/owner/clovaforge-web \
 *   WEB_IMAGE_DIGEST=sha256:... \
 *   MINIMUM_UPGRADE_VERSION=1.0.0 \
 *   NOTES_URL=https://github.com/owner/repo/releases/tag/v1.2.0 \
 *   SIGNING_PRIVATE_KEY_PEM_BASE64=<base64 of an Ed25519 private key PEM> \
 *   SIGNING_KEY_ID=<keyId matching TRUSTED_SIGNING_KEYS> \
 *   node scripts/generate-release-manifest.mjs <output-manifest-path> <output-signature-path>
 *
 * Environment variables, not flags: a private key and other release
 * metadata belong out of argv/`ps` output entirely, consistent with how
 * this repo already handles every other secret (see secrets.sh's own
 * comments on the same point).
 */

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sign as cryptoSign } from "node:crypto";

// Numeric (never lexicographic) semver compare — mirrors resolve-update.mjs and
// apps/api's isOlderSemVer, kept tiny and dependency-free like the rest of this
// script. Returns <0, 0, >0.
function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const [, , manifestOutPath, signatureOutPath] = process.argv;
if (!manifestOutPath || !signatureOutPath) {
  console.error("Usage: generate-release-manifest.mjs <output-manifest-path> <output-signature-path>");
  process.exit(1);
}

const version = requireEnv("RELEASE_VERSION");
const channel = requireEnv("RELEASE_CHANNEL");
const sourceCommit = requireEnv("SOURCE_COMMIT");
const apiRepository = requireEnv("API_IMAGE_REPOSITORY");
const apiDigest = requireEnv("API_IMAGE_DIGEST");
const webRepository = requireEnv("WEB_IMAGE_REPOSITORY");
const webDigest = requireEnv("WEB_IMAGE_DIGEST");
const minimumUpgradeVersion = requireEnv("MINIMUM_UPGRADE_VERSION");
const signingKeyPemBase64 = requireEnv("SIGNING_PRIVATE_KEY_PEM_BASE64");
const signingKeyId = requireEnv("SIGNING_KEY_ID");
const notesUrl = process.env.NOTES_URL || undefined;
const requiresManualApproval = process.env.REQUIRES_MANUAL_APPROVAL === "true";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function fail(message) {
  console.error(`generate-release-manifest: ${message}`);
  process.exit(1);
}

if (!SEMVER_PATTERN.test(version)) fail(`RELEASE_VERSION is not MAJOR.MINOR.PATCH: ${version}`);
if (!["stable", "beta", "nightly"].includes(channel)) fail(`RELEASE_CHANNEL must be stable, beta, or nightly: ${channel}`);
if (!COMMIT_PATTERN.test(sourceCommit)) fail(`SOURCE_COMMIT is not a 40-char lowercase hex sha: ${sourceCommit}`);
if (!DIGEST_PATTERN.test(apiDigest)) fail(`API_IMAGE_DIGEST is not sha256:<64-hex>: ${apiDigest}`);
if (!DIGEST_PATTERN.test(webDigest)) fail(`WEB_IMAGE_DIGEST is not sha256:<64-hex>: ${webDigest}`);
if (!SEMVER_PATTERN.test(minimumUpgradeVersion)) fail(`MINIMUM_UPGRADE_VERSION is not MAJOR.MINOR.PATCH: ${minimumUpgradeVersion}`);

// Release-validation gate (the check that would have caught v1.3.0's
// minimumUpgradeVersion=1.0.0 gating out real production at 0.1.31): the
// manifest MUST admit the oldest supported installed version. minimumUpgradeVersion
// is the floor an installation must be at OR ABOVE to jump straight to this
// release, so it must be <= oldestSupportedUpgradeFrom. release-compatibility.json
// is the single, authoritative, deliberate source of that floor — never a
// per-tag heuristic. See its own "note" for why version-string gating is the
// wrong guard for the legacy 0.1.x fleet (the true guard is computeRollbackSafety
// at apply time).
const OLDEST_SUPPORTED = (() => {
  const p = join(dirname(fileURLToPath(import.meta.url)), "..", "release-compatibility.json");
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  const v = cfg.oldestSupportedUpgradeFrom;
  if (typeof v !== "string" || !SEMVER_PATTERN.test(v)) {
    fail(`release-compatibility.json oldestSupportedUpgradeFrom is not MAJOR.MINOR.PATCH: ${v}`);
  }
  return v;
})();
if (cmpSemver(minimumUpgradeVersion, OLDEST_SUPPORTED) > 0) {
  fail(
    `minimumUpgradeVersion (${minimumUpgradeVersion}) is HIGHER than the oldest supported installed version (${OLDEST_SUPPORTED} from release-compatibility.json). ` +
      `This release would gate that production version out of upgrading. Lower MINIMUM_UPGRADE_VERSION to <= ${OLDEST_SUPPORTED}, ` +
      `or, only after validating a higher floor with tests, raise oldestSupportedUpgradeFrom.`
  );
}

const manifest = {
  schemaVersion: 1,
  version,
  channel,
  releasedAt: new Date().toISOString(),
  sourceCommit,
  api: { repository: apiRepository, digest: apiDigest },
  web: { repository: webRepository, digest: webDigest },
  minimumUpgradeVersion,
  ...(notesUrl ? { notesUrl } : {}),
  requiresManualApproval
};

// Canonical, single-line JSON — written once and never reformatted, since
// the signature covers these exact bytes.
const manifestJson = JSON.stringify(manifest);

const privateKeyPem = Buffer.from(signingKeyPemBase64, "base64").toString("utf8");
let signatureBase64;
try {
  signatureBase64 = cryptoSign(null, Buffer.from(manifestJson, "utf8"), privateKeyPem).toString("base64");
} catch (error) {
  fail(`signing failed: ${error instanceof Error ? error.message : String(error)}`);
}

const signatureEnvelope = JSON.stringify({ signature: signatureBase64, keyId: signingKeyId });

writeFileSync(manifestOutPath, manifestJson, "utf8");
writeFileSync(signatureOutPath, signatureEnvelope, "utf8");

console.log(`Wrote ${manifestOutPath} and ${signatureOutPath} for ${version} (${channel}, signed as ${signingKeyId}).`);
