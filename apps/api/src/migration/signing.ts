import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import { z } from "zod";
import { SIGNATURE_ALGORITHM } from "./constants.js";

/**
 * Origin signatures (Ed25519) over a bundle's manifest digest.
 *
 * A signature proves ORIGIN only if the verifier pins the expected signer
 * fingerprint, obtained out of band. Without a pin it proves nothing beyond
 * "self-consistent with the key it carries" — an attacker can sign their own
 * bundle with their own key. See docs/MIGRATION_BUNDLE_FORMAT.md §1 and §7.
 */

export interface SignatureFile {
  algorithm: typeof SIGNATURE_ALGORITHM;
  /** base64 SPKI DER */
  publicKey: string;
  /** "sha256:<hex of the SPKI DER>" */
  fingerprint: string;
  /** base64 */
  signature: string;
}

export const signatureFileSchema = z.strictObject({
  algorithm: z.literal(SIGNATURE_ALGORITHM),
  publicKey: z.string().min(1),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  signature: z.string().min(1)
});

export function generateSigningKeyPair(): { publicKeyDer: Buffer; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  return {
    publicKeyDer: publicKey.export({ type: "spki", format: "der" }) as Buffer,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string
  };
}

export function fingerprintOf(publicKeyDer: Buffer): string {
  return `sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`;
}

/** Normalises user-supplied fingerprints (case, optional "sha256:" prefix, separators). */
export function normalizeFingerprint(input: string): string {
  const cleaned = input.trim().toLowerCase().replace(/^sha256:/, "").replace(/[:\s-]/g, "");

  return `sha256:${cleaned}`;
}

function signedMessage(bundleId: string, manifestSha256: string): Buffer {
  return Buffer.from(`cfmig-manifest-sig-v1\0${bundleId}\0${manifestSha256}`, "utf8");
}

export function signManifest(options: {
  privateKeyPem: string;
  bundleId: string;
  manifestSha256: string;
}): SignatureFile {
  const privateKey = createPrivateKey(options.privateKeyPem);
  const publicKeyDer = createPublicKey(privateKey).export({
    type: "spki",
    format: "der"
  }) as Buffer;
  const signature = cryptoSign(null, signedMessage(options.bundleId, options.manifestSha256), privateKey);

  return {
    algorithm: SIGNATURE_ALGORITHM,
    publicKey: publicKeyDer.toString("base64"),
    fingerprint: fingerprintOf(publicKeyDer),
    signature: signature.toString("base64")
  };
}

export type SignatureCheck =
  | { valid: true; fingerprint: string }
  | { valid: false; reason: string };

/** Cryptographic check only. Whether the signer is TRUSTED is a policy decision made by the caller. */
export function verifyManifestSignature(
  file: SignatureFile,
  bundleId: string,
  manifestSha256: string
): SignatureCheck {
  try {
    const publicKeyDer = Buffer.from(file.publicKey, "base64");

    if (fingerprintOf(publicKeyDer) !== file.fingerprint) {
      return { valid: false, reason: "The signature file's fingerprint does not match its public key." };
    }

    const publicKey = createPublicKey({ key: publicKeyDer, type: "spki", format: "der" });
    const ok = cryptoVerify(
      null,
      signedMessage(bundleId, manifestSha256),
      publicKey,
      Buffer.from(file.signature, "base64")
    );

    return ok
      ? { valid: true, fingerprint: file.fingerprint }
      : { valid: false, reason: "The signature does not match this manifest." };
  } catch {
    return { valid: false, reason: "The signature file could not be processed." };
  }
}
