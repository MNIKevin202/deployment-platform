import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const CURRENT_PAYLOAD_VERSION = 1;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type EncryptionKeyUnavailableReason = "missing" | "invalid-encoding" | "invalid-length";

export type EncryptionKeyStatus =
  | { available: true; key: Buffer }
  | { available: false; reason: EncryptionKeyUnavailableReason };

/**
 * Reads and validates CREDENTIAL_ENCRYPTION_KEY (a base64-encoded 32-byte
 * AES-256 key) without ever throwing — the API must be able to start up
 * and serve every other route normally when GitHub integration has never
 * been configured, so "the key is absent" is a value to check, not an
 * exception that could crash the process.
 */
export function loadEncryptionKey(): EncryptionKeyStatus {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;

  if (!raw || raw.trim().length === 0) {
    return { available: false, reason: "missing" };
  }

  const trimmed = raw.trim();

  if (!BASE64_PATTERN.test(trimmed)) {
    return { available: false, reason: "invalid-encoding" };
  }

  const key = Buffer.from(trimmed, "base64");

  if (key.length !== KEY_LENGTH_BYTES) {
    return { available: false, reason: "invalid-length" };
  }

  return { available: true, key };
}

interface EncryptedPayload {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Thrown for any decryption failure — malformed JSON, an unsupported
 * payload version, a tampered ciphertext, a tampered auth tag, or simply
 * the wrong key. The message is intentionally generic in every case: none
 * of the underlying OpenSSL/parsing detail is safe to surface to a caller,
 * and callers should never need to distinguish "wrong key" from "tampered
 * data" — both mean the same thing operationally (treat the credential as
 * unavailable).
 */
export class DecryptionError extends Error {
  constructor(message = "Unable to decrypt payload") {
    super(message);
    this.name = "DecryptionError";
  }
}

/**
 * Encrypts `plaintext` with AES-256-GCM using a fresh random IV every
 * call, and returns a versioned, self-contained JSON payload (IV +
 * auth tag + ciphertext, all base64) suitable for storing as a single
 * TEXT column.
 */
export function encryptSecret(key: Buffer, plaintext: string): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`Encryption key must be exactly ${KEY_LENGTH_BYTES} bytes`);
  }

  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    v: CURRENT_PAYLOAD_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64")
  };

  return JSON.stringify(payload);
}

const EXPECTED_PAYLOAD_KEYS = new Set(["v", "iv", "tag", "data"]);

// Well-formed, standard (RFC 4648, padded) base64 only — no URL-safe
// alphabet, no missing padding.
const BASE64_SHAPE_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * `Buffer.from(value, "base64")` silently tolerates a lot of malformed or
 * non-canonical input (wrong padding, stray characters it just drops,
 * whitespace) rather than throwing — none of that is safe to trust for a
 * value that authenticates encrypted data. This requires the string to
 * both look like well-formed base64 *and* round-trip: decoding it and
 * re-encoding must reproduce the exact original string, which rejects any
 * non-canonical encoding that happened to match the shape pattern.
 */
function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || !BASE64_SHAPE_PATTERN.test(value)) {
    return false;
  }

  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

/** Generous but bounded — no legitimate GitHub token comes close to this. */
const MAX_CIPHERTEXT_BYTES = 1024;

function parsePayload(serialized: string): EncryptedPayload {
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new DecryptionError("Malformed encrypted payload");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DecryptionError("Malformed encrypted payload");
  }

  const keys = Object.keys(parsed);

  if (keys.length !== EXPECTED_PAYLOAD_KEYS.size || !keys.every((key) => EXPECTED_PAYLOAD_KEYS.has(key))) {
    throw new DecryptionError("Malformed encrypted payload");
  }

  const candidate = parsed as Partial<EncryptedPayload>;

  if (candidate.v !== CURRENT_PAYLOAD_VERSION) {
    throw new DecryptionError("Unsupported encrypted payload version");
  }

  if (
    typeof candidate.iv !== "string" ||
    typeof candidate.tag !== "string" ||
    typeof candidate.data !== "string" ||
    !isCanonicalBase64(candidate.iv) ||
    !isCanonicalBase64(candidate.tag) ||
    !isCanonicalBase64(candidate.data)
  ) {
    throw new DecryptionError("Malformed encrypted payload");
  }

  return candidate as EncryptedPayload;
}

/**
 * Decrypts a payload produced by `encryptSecret`. Authenticates the
 * ciphertext via the GCM tag before returning anything — any tampering,
 * corruption, or key mismatch throws `DecryptionError` rather than
 * returning garbage plaintext.
 */
export function decryptSecret(key: Buffer, serialized: string): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`Encryption key must be exactly ${KEY_LENGTH_BYTES} bytes`);
  }

  const payload = parsePayload(serialized);

  let iv: Buffer;
  let tag: Buffer;
  let data: Buffer;

  try {
    iv = Buffer.from(payload.iv, "base64");
    tag = Buffer.from(payload.tag, "base64");
    data = Buffer.from(payload.data, "base64");
  } catch {
    throw new DecryptionError("Malformed encrypted payload");
  }

  if (iv.length !== IV_LENGTH_BYTES || tag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new DecryptionError("Malformed encrypted payload");
  }

  if (data.length > MAX_CIPHERTEXT_BYTES) {
    throw new DecryptionError("Malformed encrypted payload");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    // A wrong key, a modified ciphertext, and a modified auth tag all
    // surface here as an OpenSSL "unable to authenticate data" style
    // throw — deliberately collapsed into one generic, safe error.
    throw new DecryptionError("Unable to decrypt payload");
  }
}
