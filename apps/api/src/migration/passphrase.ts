import { readFileSync, statSync } from "node:fs";
import { MigrationCryptoError, normalizePassphrase } from "./crypto.js";

/**
 * Reads a passphrase from a file. The passphrase is NEVER accepted on the
 * command line or from the environment (both leak through process listings and
 * shell history). On POSIX the file must not be readable by group or others.
 * One trailing newline is stripped; the result is NFKC-normalised and
 * length-checked. The value is never logged.
 */
export function readPassphraseFile(path: string): string {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new MigrationCryptoError(`Passphrase file not found: ${path}`);
  }

  if (!stats.isFile()) {
    throw new MigrationCryptoError(`Passphrase path is not a regular file: ${path}`);
  }

  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new MigrationCryptoError(
      `Passphrase file ${path} is accessible to other users. Restrict it first: chmod 600 ${path}`
    );
  }

  const raw = readFileSync(path, "utf8").replace(/\r?\n$/, "");

  return normalizePassphrase(raw);
}
