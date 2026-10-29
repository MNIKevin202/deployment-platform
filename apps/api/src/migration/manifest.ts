import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import {
  ARTIFACT_ID_PATTERN,
  BUNDLE_FORMAT_VERSION,
  MANIFEST_ARTIFACT_ID,
  MANIFEST_SCHEMA_VERSION
} from "./constants.js";
import { CONSISTENCY_LEVELS, EVIDENCE_KINDS, SNAPSHOT_STRATEGIES } from "./consistency.js";
import { compareSemVer, isValidSemVer } from "../services/semver.js";

/**
 * The manifest: the encrypted, authoritative inventory of a bundle. Strictly
 * validated — unknown fields are rejected so a hostile or newer manifest can
 * never be half-understood. See docs/MIGRATION_BUNDLE_FORMAT.md §6.
 */

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const artifactIdSchema = z.string().regex(ARTIFACT_ID_PATTERN);
const levelSchema = z.enum(CONSISTENCY_LEVELS);
const subjectRefSchema = z.string().regex(/^(platform|app:\d+)$/);

export const ARTIFACT_KINDS = [
  "platform-database",
  "platform-config",
  "caddy-routes",
  "app-definition",
  "volume",
  "image",
  "db-dump"
] as const;

const evidenceSchema = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS),
  detail: z.string().max(500).optional()
});

const volumeConsistencySchema = z.strictObject({
  level: levelSchema,
  strategy: z.enum(SNAPSHOT_STRATEGIES),
  evidence: z.array(evidenceSchema)
});

const artifactSchema = z.strictObject({
  id: artifactIdSchema,
  kind: z.enum(ARTIFACT_KINDS),
  subject: subjectRefSchema,
  plaintextBytes: z.number().int().nonnegative(),
  plaintextSha256: sha256Schema,
  ciphertextBytes: z.number().int().nonnegative(),
  ciphertextSha256: sha256Schema,
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({})
});

const volumeSchema = z.strictObject({
  name: z.string().min(1).max(255),
  containerPath: z.string().min(1).max(4096),
  readOnly: z.boolean(),
  artifactId: artifactIdSchema.nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  consistency: volumeConsistencySchema
});

const imageSchema = z.strictObject({
  tag: z.string().min(1).max(512),
  artifactId: artifactIdSchema.nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  role: z.enum(["current", "rollback", "dependency"])
});

const appSchema = z.strictObject({
  ref: z.string().regex(/^app:\d+$/),
  sourceAppId: z.number().int().positive(),
  name: z.string().min(1).max(255),
  containerName: z.string().min(1).max(255),
  image: z.string().min(1).max(512),
  domain: z.string().nullable(),
  internalOnly: z.boolean(),
  desiredStatus: z.string(),
  volumes: z.array(volumeSchema),
  images: z.array(imageSchema),
  /** Refs of other apps this app uses. */
  dependsOn: z.array(z.string().regex(/^app:\d+$/)),
  /** If true the importer must leave schedulers/cron/auto-deploy/webhooks OFF. */
  dormantOnImport: z.boolean()
});

const acceptedRiskSchema = z.strictObject({
  subject: subjectRefSchema,
  level: levelSchema,
  acceptedAt: z.string(),
  reason: z.string().max(1000).optional()
});

export const manifestSchema = z
  .strictObject({
    manifestSchemaVersion: z.number().int().positive(),
    bundleId: z.uuid(),
    createdAt: z.string(),
    scope: z.enum(["platform", "application"]),
    source: z.strictObject({
      serverId: z.string().min(1).max(128),
      platformVersion: z.string().min(1).max(64),
      schemaVersion: z.number().int().nonnegative(),
      arch: z.string().min(1).max(32),
      dockerVersion: z.string().max(64).optional()
    }),
    transfer: z.strictObject({
      migrationId: z.uuid(),
      operation: z.enum(["backup", "copy", "move"]),
      /** Ownership epoch used for fencing (docs/MIGRATION_DESIGN.md §6.4). */
      epoch: z.number().int().nonnegative(),
      /** For an incremental bundle, the seed it builds on. */
      previousBundleId: z.uuid().nullable()
    }),
    consistency: z.strictObject({
      mode: z.enum(["rehearsal", "cutover"]),
      overall: levelSchema,
      acceptedRisks: z.array(acceptedRiskSchema)
    }),
    apps: z.array(appSchema),
    artifacts: z.array(artifactSchema)
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();

    for (const artifact of manifest.artifacts) {
      if (artifact.id === MANIFEST_ARTIFACT_ID) {
        context.addIssue({
          code: "custom",
          message: `The artifact id "${MANIFEST_ARTIFACT_ID}" is reserved.`,
          path: ["artifacts"]
        });
      }
      if (ids.has(artifact.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate artifact id "${artifact.id}".`,
          path: ["artifacts"]
        });
      }
      ids.add(artifact.id);
    }

    const referenced = (artifactId: string | null, path: Array<string | number>): void => {
      if (artifactId !== null && !ids.has(artifactId)) {
        context.addIssue({
          code: "custom",
          message: `Artifact "${artifactId}" is referenced but not listed.`,
          path
        });
      }
    };

    manifest.apps.forEach((app, appIndex) => {
      app.volumes.forEach((volume, volumeIndex) =>
        referenced(volume.artifactId, ["apps", appIndex, "volumes", volumeIndex])
      );
      app.images.forEach((image, imageIndex) =>
        referenced(image.artifactId, ["apps", appIndex, "images", imageIndex])
      );
    });

    if (manifest.scope === "application" && manifest.apps.length === 0) {
      context.addIssue({
        code: "custom",
        message: "An application-scope bundle must contain at least one app.",
        path: ["apps"]
      });
    }

    if (new Set(manifest.apps.map((app) => app.ref)).size !== manifest.apps.length) {
      context.addIssue({ code: "custom", message: "Duplicate app refs.", path: ["apps"] });
    }

    // dependsOn may point outside the bundle (a "reconfigure" dependency) —
    // that is legitimate, so it is not an error here; the plan surfaces it.
  });

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestArtifact = z.infer<typeof artifactSchema>;
export type ManifestApp = z.infer<typeof appSchema>;

export function parseManifest(input: unknown): Manifest {
  const manifest = manifestSchema.parse(input);

  if (manifest.manifestSchemaVersion > MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Manifest schema ${manifest.manifestSchemaVersion} is newer than this ClovaForge supports ` +
        `(${MANIFEST_SCHEMA_VERSION}).`
    );
  }

  return manifest;
}

/** The exact bytes that are encrypted as manifest.enc and signed. */
export function serializeManifest(manifest: Manifest): Buffer {
  return Buffer.from(canonicalJson(manifest), "utf8");
}

// ----------------------------------------------------------- compatibility ----

export interface CompatIssue {
  code: string;
  severity: "fail" | "warn";
  message: string;
}

export interface CompatTarget {
  platformVersion: string;
  /** Highest schema-migration version the target can run. */
  schemaVersion: number;
  arch: string;
  /** Format versions the target can read. */
  supportedFormatVersions: number[];
}

/** What compatibility depends on — available from a manifest OR from live source facts. */
export interface CompatSource {
  scope: "platform" | "application";
  platformVersion: string;
  schemaVersion: number;
  arch: string;
  /** True if locally built images will need to run on the target. */
  hasLocalImages: boolean;
}

export function compatSourceOf(manifest: Manifest): CompatSource {
  return {
    scope: manifest.scope,
    platformVersion: manifest.source.platformVersion,
    schemaVersion: manifest.source.schemaVersion,
    arch: manifest.source.arch,
    hasLocalImages: manifest.artifacts.some((artifact) => artifact.kind === "image")
  };
}

/**
 * Whether a target server can import what a source describes. Pure. The rules are
 * those in docs/MIGRATION_BUNDLE_FORMAT.md §10.
 */
export function checkCompatibility(source: CompatSource, target: CompatTarget): CompatIssue[] {
  const issues: CompatIssue[] = [];

  if (!target.supportedFormatVersions.includes(BUNDLE_FORMAT_VERSION)) {
    issues.push({
      code: "format-unsupported",
      severity: "fail",
      message: "The target cannot read this bundle format version."
    });
  }

  if (source.schemaVersion > target.schemaVersion) {
    issues.push({
      code: "schema-newer-than-target",
      severity: "fail",
      message:
        source.scope === "platform"
          ? `The bundle's database schema (v${source.schemaVersion}) is newer than the target's ` +
            `(v${target.schemaVersion}). Upgrade the target first; downgrades are refused.`
          : `The source server is on schema v${source.schemaVersion} but the destination only ` +
            `supports v${target.schemaVersion}. Upgrade the destination first.`
    });
  }

  if (isValidSemVer(source.platformVersion) && isValidSemVer(target.platformVersion)) {
    if (compareSemVer(source.platformVersion, target.platformVersion) > 0) {
      issues.push({
        code: "platform-newer-than-target",
        severity: source.scope === "platform" ? "fail" : "warn",
        message:
          `The source runs ClovaForge ${source.platformVersion}, newer than the target's ` +
          `${target.platformVersion}.`
      });
    }
  } else {
    issues.push({
      code: "version-not-comparable",
      severity: "warn",
      message:
        `Platform versions "${source.platformVersion}" and "${target.platformVersion}" ` +
        "could not be compared (a development build?)."
    });
  }

  if (source.arch !== target.arch) {
    issues.push({
      code: "architecture-mismatch",
      severity: source.hasLocalImages ? "fail" : "warn",
      message:
        `Source architecture ${source.arch} differs from target ${target.arch}. ` +
        (source.hasLocalImages
          ? "Locally built images cannot run on the target."
          : "Registry images may be multi-arch, but this is not guaranteed.")
    });
  }

  return issues;
}

export function checkManifestCompatibility(manifest: Manifest, target: CompatTarget): CompatIssue[] {
  return checkCompatibility(compatSourceOf(manifest), target);
}
