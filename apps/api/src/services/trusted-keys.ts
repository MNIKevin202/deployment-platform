import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads the project's trusted release-signing public keys from PEM files on
 * disk — the single trust anchor for the whole self-update system (see
 * docs/SELF_UPDATE_ARCHITECTURE.md "Signing").
 *
 * Why files, not an in-source constant: the *exact same* PEM files are the
 * canonical source for both this API image (baked in at build time — see the
 * `COPY trusted-keys` line in apps/api/Dockerfile) and the host-level updater
 * (the installer copies them to the host, and the updater's own verify step
 * reads them). One representation, read the same way by both consumers, so a
 * key can never be trusted by one and not the other. "Add a key" = "add a
 * `<keyId>.pem` file"; nothing is generated, compiled, or hand-transcribed.
 *
 * Fail-closed is the whole point: an absent or empty directory yields an
 * empty map, and an empty trust map means every manifest signature is
 * rejected as `unknown-signing-key`. Until a real signing key is provisioned
 * (see the architecture doc), that is exactly the correct behavior — the
 * platform refuses to trust any release rather than trusting an unsigned one.
 */

/** The directory a built API image bakes its trusted keys into (Dockerfile WORKDIR is /app). */
export const DEFAULT_TRUSTED_KEYS_DIR = "/app/trusted-keys";

/** A keyId is the PEM file's basename. Constrained so a filename can never be a path or traversal. */
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Returns { keyId: pemString } for every well-named `*.pem` file in `dir`.
 * A file whose basename is not a valid keyId, or which cannot be read, is
 * skipped with no effect on the others — a single malformed file must never
 * take down the whole trust map (which would fail *open* to "no keys" only
 * in the sense that fewer keys are trusted, never more).
 */
export function loadTrustedKeysFromDir(
  dir: string = process.env.TRUSTED_KEYS_DIR ?? DEFAULT_TRUSTED_KEYS_DIR
): Record<string, string> {
  const keys: Record<string, string> = {};

  if (!existsSync(dir)) {
    return keys;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return keys;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".pem")) {
      continue;
    }
    const keyId = entry.slice(0, -".pem".length);
    if (!KEY_ID_PATTERN.test(keyId)) {
      continue;
    }
    try {
      const pem = readFileSync(join(dir, entry), "utf8").trim();
      if (pem.includes("BEGIN PUBLIC KEY")) {
        keys[keyId] = pem;
      }
    } catch {
      // Unreadable file — skip it, never fail the whole load.
    }
  }

  return keys;
}
