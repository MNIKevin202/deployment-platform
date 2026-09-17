import { z } from "zod";
import { isValidSemVer } from "../services/semver.js";

/**
 * The shape of a published ClovaForge release manifest — the artifact the
 * GitHub release pipeline signs and publishes, and every installation
 * fetches to discover what it could update to. See
 * docs/SELF_UPDATE_ARCHITECTURE.md for the full design; this file is the
 * one place that shape is allowed to be defined, so the release pipeline,
 * the API's update-checking service, and the installed host agent can
 * never quietly drift out of agreement about what a manifest contains.
 *
 * Deliberately strict rather than permissive: an update mechanism is the
 * one place where "be liberal in what you accept" is the wrong instinct.
 * Every field is validated; unknown/malformed input is rejected outright
 * rather than coerced or defaulted.
 */

export const RELEASE_CHANNELS = ["stable", "beta", "nightly"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

const semVerSchema = z
  .string()
  .refine(isValidSemVer, "Must be a MAJOR.MINOR.PATCH version");

/** A lowercase hex `sha256:<64 hex chars>` digest — an OCI image digest, never a mutable tag. */
const imageDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Must be a sha256:<64-hex> image digest");

/** A full 40-character lowercase hex git commit SHA. */
const gitCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "Must be a full 40-character git commit SHA");

const imageRefSchema = z.object({
  /** Registry repository, e.g. "ghcr.io/owner/clovaforge-api". Never a bare tag. */
  repository: z.string().min(1).max(300),
  digest: imageDigestSchema
});

export const releaseManifestSchema = z.object({
  /** Manifest schema version, so a future incompatible shape can be detected before parsing the rest. */
  schemaVersion: z.literal(1),
  version: semVerSchema,
  channel: z.enum(RELEASE_CHANNELS),
  releasedAt: z.string().datetime(),
  sourceCommit: gitCommitSchema,
  api: imageRefSchema,
  web: imageRefSchema,
  /**
   * The oldest installed version this release can safely upgrade FROM in one
   * step. An installation older than this must be told to upgrade
   * incrementally rather than jumping straight here — protects against a
   * migration or config-shape assumption that only holds for recent
   * installs.
   */
  minimumUpgradeVersion: semVerSchema,
  // Rollback safety is deliberately NOT carried here: which migrations a
  // given upgrade will actually run depends on the installation's current
  // version, which only that installation knows (via its own
  // schema_migrations table). Each installation determines this itself,
  // from its own already-applied migration state plus the new release's
  // own migration files (each carrying a `risk` classification — see
  // apps/api/src/migrations/types.ts) — see
  // docs/SELF_UPDATE_ARCHITECTURE.md "Migration safety".
  /** Human-readable release notes; a URL keeps the manifest itself small. */
  notesUrl: z.string().url().optional(),
  /**
   * True marks this release as one no installation should ever apply
   * automatically, regardless of its own update policy — a published
   * mistake, a security issue found post-release, or a release requiring
   * manual intervention. "Notify only" and "Update Now" still work.
   */
  requiresManualApproval: z.boolean().default(false)
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/**
 * The detached signature envelope published alongside a manifest — never
 * embedded in the manifest itself, so the exact signed bytes are
 * unambiguous (the manifest file's raw bytes, not a re-serialization of the
 * parsed object, which could differ in key order or whitespace).
 */
export const releaseManifestSignatureSchema = z.object({
  /** Ed25519 signature over the raw manifest.json bytes, base64-encoded. */
  signature: z.string().min(1),
  /**
   * Identifies which of the project's known public keys signed this — see
   * docs/SELF_UPDATE_ARCHITECTURE.md "Signing" for the current key and its
   * rotation history. Never used to look up a key from anywhere other than
   * the fixed, baked-in trust list; an installation never trusts a keyId it
   * doesn't already recognize.
   */
  keyId: z.string().min(1).max(100)
});

export type ReleaseManifestSignature = z.infer<typeof releaseManifestSignatureSchema>;

/** Parses and validates a manifest, returning a discriminated success/failure result rather than throwing. */
export function parseReleaseManifest(
  raw: unknown
):
  | { success: true; manifest: ReleaseManifest }
  | { success: false; error: string } {
  const result = releaseManifestSchema.safeParse(raw);
  if (!result.success) {
    return { success: false, error: result.error.message };
  }
  return { success: true, manifest: result.data };
}
