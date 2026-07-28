import { createHash } from "node:crypto";

/**
 * Namespaces idempotency keys per operation type, so this shared table can
 * be reused by future idempotent endpoints without key collisions between
 * unrelated operations.
 */
export const APP_CREATION_IDEMPOTENCY_SCOPE = "app-creation";
export const APP_DELETION_IDEMPOTENCY_SCOPE = "app-deletion";

// Client-generated (crypto.randomUUID() on the browser), so this is
// intentionally generous but still bounded and restricted to a safe
// character set — it is stored in the database and must never be able to
// carry anything resembling SQL, HTML, or control characters.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * A stable fingerprint of the fields that define "the same logical
 * request." Two requests that reuse the same idempotency key but carry a
 * different fingerprint are not the same attempt — one is a bug, a key
 * collision, or an attacker — and must be rejected, never replayed and
 * never treated as if they were the same create.
 */
export function fingerprintCreateAppRequest(input: {
  name: string;
  image: string;
  containerPort: number;
  restartPolicy?: string;
  environmentVariables?: unknown;
  storageMounts?: unknown;
  internalOnly?: boolean;
  customDomain?: string;
}): string {
  const normalized = {
    name: input.name,
    image: input.image,
    containerPort: input.containerPort,
    restartPolicy: input.restartPolicy ?? null,
    environmentVariables: input.environmentVariables ?? [],
    // Included so a repeated key with different routing/domain choices is a
    // mismatch, not a replay — trimmed+lowercased the same way
    // validateCustomDomain() normalizes it, so two requests differing only
    // by domain casing/whitespace still fingerprint identically.
    internalOnly: input.internalOnly ?? false,
    customDomain: input.customDomain?.trim().toLowerCase() ?? null,
    storageMounts: input.storageMounts ?? []
  };

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * A stable fingerprint of a delete request: the container id being deleted
 * is the only thing that identifies "the same logical delete." Reusing a key
 * against a DIFFERENT container id is a mismatch, never a replay.
 */
export function fingerprintDeleteAppRequest(containerId: string): string {
  return createHash("sha256").update(JSON.stringify({ containerId })).digest("hex");
}

/** Reads and validates the Idempotency-Key header. Absent is fine (opt-in). */
export function readIdempotencyKeyHeader(
  headerValue: string | string[] | undefined
): { present: false } | { present: true; valid: true; key: string } | { present: true; valid: false } {
  if (headerValue === undefined) {
    return { present: false };
  }

  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (isValidIdempotencyKey(raw)) {
    return { present: true, valid: true, key: raw };
  }

  return { present: true, valid: false };
}
