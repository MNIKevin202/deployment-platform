import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import type { ReleaseManifest } from "../schemas/release-manifest.js";
import {
  evaluateUpdateAvailability,
  fetchAndVerifyManifest,
  verifyManifestSignature,
  type ManifestFetchImpl
} from "../services/release-manifest-service.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const TEST_KEY_ID = "test-key-1";
const TRUSTED_KEYS = Object.freeze({
  [TEST_KEY_ID]: publicKey.export({ type: "spki", format: "pem" }).toString()
});

function baseManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schemaVersion: 1,
    version: "1.2.0",
    channel: "stable",
    releasedAt: "2026-09-16T20:00:00.000Z",
    sourceCommit: "a".repeat(40),
    api: {
      repository: "ghcr.io/owner/clovaforge-api",
      digest: `sha256:${"b".repeat(64)}`
    },
    web: {
      repository: "ghcr.io/owner/clovaforge-web",
      digest: `sha256:${"c".repeat(64)}`
    },
    minimumUpgradeVersion: "1.0.0",
    requiresManualApproval: false,
    ...overrides
  };
}

function signManifest(manifestJson: string): string {
  return cryptoSign(null, Buffer.from(manifestJson, "utf8"), privateKey).toString("base64");
}

function fakeFetch(responses: Record<string, { ok: boolean; status: number; body: string }>): ManifestFetchImpl {
  return async (url: string) => {
    const response = responses[url];
    if (!response) {
      throw new Error(`Unhandled fetch in test: ${url}`);
    }
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body
    };
  };
}

const MANIFEST_URL = "https://releases.example.com/stable/manifest.json";
const SIGNATURE_URL = "https://releases.example.com/stable/manifest.json.sig";

describe("release-manifest-service", () => {
  test("verifyManifestSignature accepts a signature from a trusted key over the exact bytes", () => {
    const manifestJson = JSON.stringify(baseManifest());
    const signature = signManifest(manifestJson);
    assert.equal(verifyManifestSignature(manifestJson, signature, TEST_KEY_ID, TRUSTED_KEYS), true);
  });

  test("verifyManifestSignature rejects a signature over different bytes (tampered manifest)", () => {
    const manifestJson = JSON.stringify(baseManifest());
    const signature = signManifest(manifestJson);
    const tampered = JSON.stringify(baseManifest({ version: "9.9.9" }));
    assert.equal(verifyManifestSignature(tampered, signature, TEST_KEY_ID, TRUSTED_KEYS), false);
  });

  test("verifyManifestSignature rejects an unknown keyId even with a well-formed signature", () => {
    const manifestJson = JSON.stringify(baseManifest());
    const signature = signManifest(manifestJson);
    assert.equal(verifyManifestSignature(manifestJson, signature, "not-a-real-key", TRUSTED_KEYS), false);
  });

  test("verifyManifestSignature never throws on garbage input", () => {
    assert.equal(verifyManifestSignature("{}", "not-valid-base64!!", TEST_KEY_ID, TRUSTED_KEYS), false);
    assert.equal(verifyManifestSignature("{}", "", TEST_KEY_ID, TRUSTED_KEYS), false);
  });

  test("fetchAndVerifyManifest succeeds end-to-end for a validly signed, valid manifest", async () => {
    const manifest = baseManifest();
    const manifestJson = JSON.stringify(manifest);
    const signature = signManifest(manifestJson);
    const fetchImpl = fakeFetch({
      [MANIFEST_URL]: { ok: true, status: 200, body: manifestJson },
      [SIGNATURE_URL]: {
        ok: true,
        status: 200,
        body: JSON.stringify({ signature, keyId: TEST_KEY_ID })
      }
    });

    const result = await fetchAndVerifyManifest(MANIFEST_URL, SIGNATURE_URL, fetchImpl, TRUSTED_KEYS);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.manifest.version, "1.2.0");
    }
  });

  test("fetchAndVerifyManifest refuses non-HTTPS URLs before making any request", async () => {
    const fetchImpl: ManifestFetchImpl = async () => {
      throw new Error("must not be called");
    };
    const result = await fetchAndVerifyManifest(
      "http://releases.example.com/manifest.json",
      SIGNATURE_URL,
      fetchImpl,
      TRUSTED_KEYS
    );
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, "url-not-https");
    }
  });

  test("fetchAndVerifyManifest reports fetch-failed on a non-2xx response", async () => {
    const fetchImpl = fakeFetch({
      [MANIFEST_URL]: { ok: false, status: 404, body: "not found" },
      [SIGNATURE_URL]: { ok: true, status: 200, body: "{}" }
    });
    const result = await fetchAndVerifyManifest(MANIFEST_URL, SIGNATURE_URL, fetchImpl, TRUSTED_KEYS);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, "fetch-failed");
    }
  });

  test("fetchAndVerifyManifest rejects malformed JSON", async () => {
    // The signature must verify against the exact malformed body — this
    // test is specifically about the JSON.parse failure path, which only
    // runs after signature verification has already passed.
    const malformedBody = "{not valid json";
    const signature = signManifest(malformedBody);
    const fetchImpl = fakeFetch({
      [MANIFEST_URL]: { ok: true, status: 200, body: malformedBody },
      [SIGNATURE_URL]: {
        ok: true,
        status: 200,
        body: JSON.stringify({ signature, keyId: TEST_KEY_ID })
      }
    });
    const result = await fetchAndVerifyManifest(MANIFEST_URL, SIGNATURE_URL, fetchImpl, TRUSTED_KEYS);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, "invalid-json");
    }
  });

  test("fetchAndVerifyManifest rejects a manifest failing schema validation", async () => {
    const badManifest = { ...baseManifest(), version: "not-semver" };
    const manifestJson = JSON.stringify(badManifest);
    const signature = signManifest(manifestJson);
    const fetchImpl = fakeFetch({
      [MANIFEST_URL]: { ok: true, status: 200, body: manifestJson },
      [SIGNATURE_URL]: {
        ok: true,
        status: 200,
        body: JSON.stringify({ signature, keyId: TEST_KEY_ID })
      }
    });
    const result = await fetchAndVerifyManifest(MANIFEST_URL, SIGNATURE_URL, fetchImpl, TRUSTED_KEYS);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, "invalid-manifest");
    }
  });

  test("fetchAndVerifyManifest rejects an unknown signing key", async () => {
    const manifestJson = JSON.stringify(baseManifest());
    const signature = signManifest(manifestJson);
    const fetchImpl = fakeFetch({
      [MANIFEST_URL]: { ok: true, status: 200, body: manifestJson },
      [SIGNATURE_URL]: {
        ok: true,
        status: 200,
        body: JSON.stringify({ signature, keyId: "attacker-key" })
      }
    });
    const result = await fetchAndVerifyManifest(MANIFEST_URL, SIGNATURE_URL, fetchImpl, TRUSTED_KEYS);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, "unknown-signing-key");
    }
  });

  test("fetchAndVerifyManifest rejects a tampered manifest even with a structurally valid signature envelope", async () => {
    const originalJson = JSON.stringify(baseManifest());
    const signature = signManifest(originalJson);
    // The attacker swaps in a different (still schema-valid) manifest body but
    // keeps the signature computed over the original — must not verify.
    const tamperedJson = JSON.stringify(baseManifest({ version: "9.9.9" }));
    const fetchImpl = fakeFetch({
      [MANIFEST_URL]: { ok: true, status: 200, body: tamperedJson },
      [SIGNATURE_URL]: {
        ok: true,
        status: 200,
        body: JSON.stringify({ signature, keyId: TEST_KEY_ID })
      }
    });
    const result = await fetchAndVerifyManifest(MANIFEST_URL, SIGNATURE_URL, fetchImpl, TRUSTED_KEYS);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, "signature-verification-failed");
    }
  });

  test("fetchAndVerifyManifest rejects a malformed signature envelope", async () => {
    const manifestJson = JSON.stringify(baseManifest());
    const fetchImpl = fakeFetch({
      [MANIFEST_URL]: { ok: true, status: 200, body: manifestJson },
      [SIGNATURE_URL]: { ok: true, status: 200, body: JSON.stringify({ signature: 123 }) }
    });
    const result = await fetchAndVerifyManifest(MANIFEST_URL, SIGNATURE_URL, fetchImpl, TRUSTED_KEYS);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, "invalid-signature-envelope");
    }
  });
});

describe("evaluateUpdateAvailability", () => {
  test("reports an update when the manifest version is newer", () => {
    const result = evaluateUpdateAvailability("1.2.0", baseManifest({ version: "1.3.0" }));
    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestVersion, "1.3.0");
  });

  test("reports no update when current is already the manifest version", () => {
    const result = evaluateUpdateAvailability("1.2.0", baseManifest({ version: "1.2.0" }));
    assert.equal(result.updateAvailable, false);
  });

  test("flags requiresIncrementalUpgrade when current is older than minimumUpgradeVersion", () => {
    const result = evaluateUpdateAvailability(
      "0.5.0",
      baseManifest({ version: "2.0.0", minimumUpgradeVersion: "1.0.0" })
    );
    assert.equal(result.requiresIncrementalUpgrade, true);
  });

  test("does not flag requiresIncrementalUpgrade when current already meets the minimum", () => {
    const result = evaluateUpdateAvailability(
      "1.0.0",
      baseManifest({ version: "2.0.0", minimumUpgradeVersion: "1.0.0" })
    );
    assert.equal(result.requiresIncrementalUpgrade, false);
  });

  test("surfaces requiresManualApproval from the manifest unchanged", () => {
    const result = evaluateUpdateAvailability("1.0.0", baseManifest({ requiresManualApproval: true }));
    assert.equal(result.requiresManualApproval, true);
  });
});

// Reads the authoritative compatibility floor by walking up from this file to
// the repo root — independent of whether tests run from src/ or dist/.
function findRepoFile(name: string): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(d, name);
    if (existsSync(candidate)) return candidate;
    d = dirname(d);
  }
  throw new Error(`${name} not found walking up from the test file`);
}

// Real production regression: srv652219 runs a legacy release.sh per-box counter
// (app 0.1.31) whose DB is already at migration 28. Its version string is
// DECOUPLED from schema age, so a minimumUpgradeVersion floor set from a
// previous-tag heuristic (1.0.0) wrongly gated it out of upgrading. These tests
// lock the bug and its fix, and — critically — validate every real release's
// declared floor against the authoritative oldest-supported version so this
// dev-VPS/production-version confusion cannot recur.
describe("release compatibility: the real production fleet floor (0.1.31)", () => {
  const compat = JSON.parse(readFileSync(findRepoFile("release-compatibility.json"), "utf8")) as {
    oldestSupportedUpgradeFrom: string;
  };
  const oldest = compat.oldestSupportedUpgradeFrom;

  test("release-compatibility.json declares a valid oldest-supported version", () => {
    assert.match(oldest, /^\d+\.\d+\.\d+$/);
  });

  test("the real production version 0.1.31 is at or above the declared floor", () => {
    // If this fails, production (0.1.31) would be gated out; the floor was
    // raised without retiring that box.
    const [oa, ob, oc] = oldest.split(".").map(Number);
    const [pa, pb, pc] = "0.1.31".split(".").map(Number);
    const prodMeetsFloor = pa > oa || (pa === oa && (pb > ob || (pb === ob && pc >= oc)));
    assert.equal(prodMeetsFloor, true, `production 0.1.31 is below the declared floor ${oldest}`);
  });

  test("a release floored at the fleet floor admits the real production version (no incremental gate)", () => {
    const result = evaluateUpdateAvailability(
      "0.1.31",
      baseManifest({ version: "1.3.0", minimumUpgradeVersion: oldest })
    );
    assert.equal(result.updateAvailable, true);
    assert.equal(result.requiresIncrementalUpgrade, false);
    assert.equal(result.latestVersion, "1.3.0");
  });

  test("the v1.3.0 mistake (minimumUpgradeVersion=1.0.0) DID gate 0.1.31 out", () => {
    const result = evaluateUpdateAvailability(
      "0.1.31",
      baseManifest({ version: "1.3.0", minimumUpgradeVersion: "1.0.0" })
    );
    assert.equal(result.requiresIncrementalUpgrade, true);
  });
});

// Rollback-safety tests live in migrations.test.ts, next to
// computeRollbackSafety — it depends on this installation's own applied
// migration state, not on anything the manifest carries. See that file's
// "computeRollbackSafety" describe block.
