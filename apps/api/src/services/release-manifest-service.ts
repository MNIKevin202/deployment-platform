import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  releaseManifestSchema,
  releaseManifestSignatureSchema,
  type ReleaseManifest
} from "../schemas/release-manifest.js";
import { compareSemVer, isOlderSemVer } from "./semver.js";
import { loadTrustedKeysFromDir } from "./trusted-keys.js";

/**
 * Fetches and verifies release manifests for the platform's own
 * self-update system. See docs/SELF_UPDATE_ARCHITECTURE.md for the full
 * design — this is the "discover + verify" half only; nothing in this
 * file ever pulls an image, touches a container, or runs a migration. A
 * manifest that fails validation or signature verification is never
 * exposed to the caller as anything other than an explicit failure.
 */

/** The narrow slice of `fetch` this service needs — kept separate from the global so
 *  tests can supply a fake, matching the existing FetchImpl pattern in notification-service.ts. */
export type ManifestFetchImpl = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const defaultFetch: ManifestFetchImpl = (url) =>
  fetch(url) as unknown as ReturnType<ManifestFetchImpl>;

/**
 * The project's known Ed25519 public signing keys, by keyId — loaded from
 * the trusted-keys PEM directory (see trusted-keys.ts). A manifest signed
 * by a keyId not present is rejected outright; there is no mechanism for a
 * manifest, a URL, or any network response to add a new trusted key. See
 * docs/SELF_UPDATE_ARCHITECTURE.md "Signing". Read fresh each call so a
 * newly-provisioned key file is picked up without a process restart; the
 * directory holds a handful of tiny files, so this is cheap.
 */
export function getDefaultTrustedKeys(): Readonly<Record<string, string>> {
  return loadTrustedKeysFromDir();
}

export type ManifestFailureReason =
  | "fetch-failed"
  | "invalid-json"
  | "invalid-manifest"
  | "invalid-signature-envelope"
  | "unknown-signing-key"
  | "signature-verification-failed"
  | "url-not-https";

export type ManifestResult =
  | { success: true; manifest: ReleaseManifest }
  | { success: false; reason: ManifestFailureReason; detail: string };

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Verifies an Ed25519 signature over the manifest's raw bytes exactly as
 * downloaded — never over a re-serialization of the parsed object, which
 * could legitimately differ in key order or whitespace from what was
 * actually signed.
 */
export function verifyManifestSignature(
  rawManifestBytes: string,
  signatureBase64: string,
  keyId: string,
  trustedKeys: Readonly<Record<string, string>> = getDefaultTrustedKeys()
): boolean {
  const publicKeyPem = trustedKeys[keyId];
  if (!publicKeyPem) {
    return false;
  }

  try {
    const publicKey = createPublicKey(publicKeyPem);
    const signature = Buffer.from(signatureBase64, "base64");
    // Ed25519 verification takes no separate digest algorithm — null is
    // the correct/required first argument for node:crypto's Ed25519 path.
    return cryptoVerify(null, Buffer.from(rawManifestBytes, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Fetches a manifest and its detached signature from the given URLs (both
 * must be HTTPS — a plain-HTTP manifest or signature URL is refused before
 * any request is made, since anything fetched over HTTP could be
 * substituted by a network attacker before verification ever runs),
 * verifies the signature against the raw downloaded bytes, then parses and
 * schema-validates the manifest. Every failure mode returns a typed
 * `success: false` result — this function never throws for a
 * network/format/trust problem, only for a programmer error.
 */
export async function fetchAndVerifyManifest(
  manifestUrl: string,
  signatureUrl: string,
  fetchImpl: ManifestFetchImpl = defaultFetch,
  trustedKeys: Readonly<Record<string, string>> = getDefaultTrustedKeys()
): Promise<ManifestResult> {
  if (!isHttpsUrl(manifestUrl) || !isHttpsUrl(signatureUrl)) {
    return {
      success: false,
      reason: "url-not-https",
      detail: "Both the manifest and signature URLs must be HTTPS."
    };
  }

  let rawManifest: string;
  let rawSignature: string;
  try {
    const [manifestResponse, signatureResponse] = await Promise.all([
      fetchImpl(manifestUrl),
      fetchImpl(signatureUrl)
    ]);
    if (!manifestResponse.ok) {
      return {
        success: false,
        reason: "fetch-failed",
        detail: `Manifest request failed: HTTP ${manifestResponse.status}`
      };
    }
    if (!signatureResponse.ok) {
      return {
        success: false,
        reason: "fetch-failed",
        detail: `Signature request failed: HTTP ${signatureResponse.status}`
      };
    }
    rawManifest = await manifestResponse.text();
    rawSignature = await signatureResponse.text();
  } catch (error) {
    return {
      success: false,
      reason: "fetch-failed",
      detail: error instanceof Error ? error.message : "Network request failed"
    };
  }

  let signatureJson: unknown;
  try {
    signatureJson = JSON.parse(rawSignature);
  } catch {
    return {
      success: false,
      reason: "invalid-signature-envelope",
      detail: "Signature response was not valid JSON."
    };
  }

  const parsedSignature = releaseManifestSignatureSchema.safeParse(signatureJson);
  if (!parsedSignature.success) {
    return {
      success: false,
      reason: "invalid-signature-envelope",
      detail: parsedSignature.error.message
    };
  }

  if (!(parsedSignature.data.keyId in trustedKeys)) {
    return {
      success: false,
      reason: "unknown-signing-key",
      detail: `keyId "${parsedSignature.data.keyId}" is not a trusted signing key.`
    };
  }

  if (
    !verifyManifestSignature(
      rawManifest,
      parsedSignature.data.signature,
      parsedSignature.data.keyId,
      trustedKeys
    )
  ) {
    return {
      success: false,
      reason: "signature-verification-failed",
      detail: "The manifest's signature does not match its content."
    };
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(rawManifest);
  } catch {
    return { success: false, reason: "invalid-json", detail: "Manifest response was not valid JSON." };
  }

  const parsedManifest = releaseManifestSchema.safeParse(manifestJson);
  if (!parsedManifest.success) {
    return { success: false, reason: "invalid-manifest", detail: parsedManifest.error.message };
  }

  return { success: true, manifest: parsedManifest.data };
}

export interface UpdateAvailability {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  /** True when `currentVersion` is older than the manifest's declared `minimumUpgradeVersion` — a
   *  direct jump to this release is not supported; the operator must upgrade incrementally first. */
  requiresIncrementalUpgrade: boolean;
  requiresManualApproval: boolean;
}

/** Compares the current running version against a verified manifest — pure, no network/IO. */
export function evaluateUpdateAvailability(
  currentVersion: string,
  manifest: ReleaseManifest
): UpdateAvailability {
  return {
    updateAvailable: compareSemVer(manifest.version, currentVersion) > 0,
    currentVersion,
    latestVersion: manifest.version,
    requiresIncrementalUpgrade: isOlderSemVer(currentVersion, manifest.minimumUpgradeVersion),
    requiresManualApproval: manifest.requiresManualApproval
  };
}

// Rollback safety is intentionally NOT computed here — see
// apps/api/src/migrations/index.ts's computeRollbackSafety, which is the
// authority: it depends on this installation's own already-applied
// migration state, not anything a manifest carries.
