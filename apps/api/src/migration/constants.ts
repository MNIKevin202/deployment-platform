/**
 * Constants shared by the migration foundation. Nothing here has side effects.
 * The values are part of the on-disk contract documented in
 * docs/MIGRATION_BUNDLE_FORMAT.md — changing one is a format change.
 */

export const BUNDLE_FORMAT = "clovaforge-migration-bundle";
export const BUNDLE_FORMAT_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 1;
export const REPORT_SCHEMA_VERSION = 1;
export const DESCRIPTOR_SCHEMA_VERSION = 1;

export const CIPHER_ID = "aes-256-gcm-stream-v1";

export const HEADER_FILE = "bundle.header.json";
export const MANIFEST_FILE = "manifest.enc";
export const SIGNATURE_FILE = "manifest.sig.json";
export const ARTIFACT_DIR = "artifacts";
export const ARTIFACT_EXTENSION = ".enc";

/** The reserved artifact id used for the encrypted manifest stream. */
export const MANIFEST_ARTIFACT_ID = "manifest";

export const STREAM_MAGIC = Buffer.from("CFAF", "ascii");
export const STREAM_VERSION = 1;
export const STREAM_SALT_BYTES = 16;
/** magic(4) + version(1) + log2(chunk)(1) + salt(16) */
export const STREAM_HEADER_BYTES = 4 + 1 + 1 + STREAM_SALT_BYTES;
export const GCM_TAG_BYTES = 16;
export const GCM_NONCE_BYTES = 12;

export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

export const MIN_PASSPHRASE_LENGTH = 12;

/** Production KDF cost. Tests inject cheaper parameters through the options. */
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;
/** Bounds enforced on header-supplied parameters (downgrade / memory-DoS defence). */
export const KDF_MIN_N = 2 ** 14;
export const KDF_MAX_N = 2 ** 19;
export const KDF_MAX_R = 16;
export const KDF_MAX_P = 4;
export const KDF_SALT_BYTES = 32;
/** scrypt needs ~128*N*r bytes. Capping the PRODUCT bounds what a hostile header can make us allocate. */
export const KDF_MAX_MEMORY_BYTES = 256 * 1024 * 1024;
export const MAX_KEY_SLOTS = 4;

/** Untrusted files are size-checked BEFORE being read into memory. */
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_SIGNATURE_BYTES = 16 * 1024;
export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

export const BUNDLE_KEY_BYTES = 32;

/** Artifact ids become file names, so they are restricted (path-traversal defence). */
export const ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const SIGNATURE_ALGORITHM = "ed25519";

/** CLI exit codes (documented in MIGRATION_BUNDLE_FORMAT.md §11). */
export const EXIT_READY = 0;
export const EXIT_USAGE = 2;
export const EXIT_INTERNAL = 3;
export const EXIT_WARNINGS = 10;
export const EXIT_BLOCKED = 20;
/** An export failed; every application was restored and any partial bundle removed. */
export const EXIT_EXPORT_FAILED = 4;
/** An export failed AND an application could not be restored: needs a human immediately. */
export const EXIT_RESTORE_FAILED = 5;

/** Docker labels used to prove ownership of resources an import creates. */
export const LABEL_MIGRATION_ID = "com.deployment-platform.migration-id";
export const LABEL_MIGRATION_ARTIFACT = "com.deployment-platform.migration-artifact";
export const LABEL_ARTIFACT_SHA256 = "com.deployment-platform.artifact-sha256";
export const LABEL_MANAGED = "com.deployment-platform.managed";
