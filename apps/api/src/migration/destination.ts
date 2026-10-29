import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  BUNDLE_FORMAT_VERSION,
  DESCRIPTOR_SCHEMA_VERSION,
  LABEL_ARTIFACT_SHA256,
  LABEL_MIGRATION_ID
} from "./constants.js";
import { appRef, type PlatformFacts } from "./facts.js";
import {
  checkCompatibility,
  compatSourceOf,
  type CompatSource,
  type CompatTarget,
  type Manifest
} from "./manifest.js";
import type { ContainerSummary, DiskUsage, HostFacts, ImageSummary, VolumeSummary } from "./probes.js";
import { formatBytes, type CheckResult } from "./report.js";

/**
 * What a destination server looks like (the DESCRIPTOR it can publish about
 * itself), what a migration REQUIRES of it (the REQUIREMENTS), and the pure
 * evaluation that compares the two.
 *
 * The same evaluator serves both views: the source asks "can that server take
 * this app?" using a descriptor it was given, and the destination asks "can I
 * take this bundle?" using its own descriptor. Nothing here touches Docker.
 */

export interface ResourceMarker {
  name: string;
  /** Label proving which migration created it; null if it was not created by one. */
  migrationId: string | null;
  artifactSha256: string | null;
  /** For images: the image id, so identical content is recognisable. */
  contentId: string | null;
}

export interface DestinationDescriptor {
  schemaVersion: typeof DESCRIPTOR_SCHEMA_VERSION;
  generatedAt: string;
  server: {
    serverId: string;
    hostname: string;
    arch: string;
    osDescription: string;
    dockerVersion: string;
    memTotalBytes: number;
    cpuCount: number;
    freeDiskBytes: number | null;
    totalDiskBytes: number | null;
  };
  platform: {
    installed: boolean;
    version: string;
    schemaVersion: number;
    supportedFormatVersions: number[];
    capabilities: { preflight: boolean; bundleVerify: boolean; export: boolean; import: boolean };
  };
  /** One-way identifier of the credential key: equal ids mean the same key. Never the key. */
  credentialKeyId: string | null;
  inventory: {
    appNames: string[];
    containerNames: string[];
    domains: string[];
    /** "25565/udp" */
    hostPorts: string[];
    credentialCount: number;
    volumes: ResourceMarker[];
    images: ResourceMarker[];
    containers: ResourceMarker[];
  };
}

/** A one-way key identifier (HMAC of a constant under the key). Safe to share. */
export function credentialKeyId(key: Buffer): string {
  return createHmac("sha256", key).update("cfmig-keyid-v1").digest("hex").slice(0, 16);
}

function markerOf(name: string, labels: Record<string, string>, contentId: string | null = null): ResourceMarker {
  return {
    name,
    migrationId: labels[LABEL_MIGRATION_ID] ?? null,
    artifactSha256: labels[LABEL_ARTIFACT_SHA256] ?? null,
    contentId
  };
}

export function buildDescriptor(input: {
  host: HostFacts;
  platformVersion: string;
  facts: PlatformFacts | null;
  maxSchemaVersion: number;
  keyId: string | null;
  containers: ContainerSummary[];
  volumes: VolumeSummary[];
  images: ImageSummary[];
  now?: Date;
}): DestinationDescriptor {
  const { facts } = input;

  return {
    schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    server: {
      serverId: input.host.serverId,
      hostname: input.host.hostname,
      arch: input.host.arch,
      osDescription: input.host.osDescription,
      dockerVersion: input.host.dockerVersion,
      memTotalBytes: input.host.memTotalBytes,
      cpuCount: input.host.cpuCount,
      freeDiskBytes: input.host.freeDiskBytes,
      totalDiskBytes: input.host.totalDiskBytes
    },
    platform: {
      installed: facts !== null,
      version: input.platformVersion,
      schemaVersion: facts?.schemaVersion ?? input.maxSchemaVersion,
      supportedFormatVersions: [BUNDLE_FORMAT_VERSION],
      // Honest about this build: it can inspect and verify, not yet export or import.
      capabilities: { preflight: true, bundleVerify: true, export: false, import: false }
    },
    credentialKeyId: input.keyId,
    inventory: {
      appNames: facts?.apps.map((app) => app.name) ?? [],
      containerNames: input.containers.map((container) => container.name),
      domains: (facts?.apps ?? []).flatMap((app) => (app.domain ? [app.domain.toLowerCase()] : [])),
      hostPorts: (facts?.apps ?? []).flatMap((app) =>
        app.publishedPorts.map((port) => `${port.hostPort}/${port.protocol}`)
      ),
      credentialCount: facts?.credentialProviders.length ?? 0,
      volumes: input.volumes.map((volume) => markerOf(volume.name, volume.labels)),
      images: input.images.flatMap((image) => image.tags.map((tag) => markerOf(tag, {}, image.id))),
      containers: input.containers.map((container) => markerOf(container.name, container.labels))
    }
  };
}

// ------------------------------------------------------------ requirements ----

export interface RequiredApp {
  ref: string;
  name: string;
  containerName: string;
  domain: string | null;
  hostPorts: string[];
  volumeNames: string[];
  /** Locally built image tags that must be carried (they exist on no registry). */
  imageTags: string[];
  memoryLimitMb: number | null;
}

export interface MigrationRequirements {
  scope: "platform" | "application";
  operation: "backup" | "copy" | "move";
  source: CompatSource;
  /** The migration this refers to, when known (from a manifest): lets "ours" be recognised. */
  migrationId: string | null;
  apps: RequiredApp[];
  /** Bytes the bundle will hold, or null if nothing could be sized. */
  totalBytes: number | null;
  /** Volumes/images whose size could not be determined. */
  unknownSizeItems: number;
  sourceCredentialKeyId: string | null;
}

const LOCAL_BUILD_PREFIX = "deployment-app-";

export function isLocalBuildTag(tag: string): boolean {
  return tag.startsWith(LOCAL_BUILD_PREFIX);
}

export function requirementsFromFacts(input: {
  facts: PlatformFacts;
  scope: "platform" | "application";
  operation: "backup" | "copy" | "move";
  appIds: number[];
  usage: DiskUsage;
  localImageTags: Set<string>;
  platformVersion: string;
  arch: string;
  sourceCredentialKeyId: string | null;
}): MigrationRequirements {
  const chosen = input.facts.apps.filter((app) => input.appIds.includes(app.id));
  let totalBytes = 0;
  let sized = false;
  let unknown = 0;

  const apps: RequiredApp[] = chosen.map((app) => {
    for (const volume of app.volumes) {
      const size = input.usage.volumeSizes.get(volume.volumeName);
      if (typeof size === "number") {
        totalBytes += size;
        sized = true;
      } else {
        unknown += 1;
      }
    }

    const imageTags = [
      ...new Set(
        app.deployments
          .map((deployment) => deployment.imageTag)
          .filter((tag) => isLocalBuildTag(tag) && input.localImageTags.has(tag))
      )
    ];
    for (const tag of imageTags) {
      const size = input.usage.imageSizes.get(tag);
      if (typeof size === "number") {
        totalBytes += size;
        sized = true;
      } else {
        unknown += 1;
      }
    }

    return {
      ref: appRef(app.id),
      name: app.name,
      containerName: app.containerName,
      domain: app.domain,
      hostPorts: app.publishedPorts.map((port) => `${port.hostPort}/${port.protocol}`),
      volumeNames: app.volumes.map((volume) => volume.volumeName),
      imageTags,
      memoryLimitMb: app.memoryLimitMb
    };
  });

  return {
    scope: input.scope,
    operation: input.operation,
    source: {
      scope: input.scope,
      platformVersion: input.platformVersion,
      schemaVersion: input.facts.schemaVersion,
      arch: input.arch,
      hasLocalImages: apps.some((app) => app.imageTags.length > 0)
    },
    migrationId: null,
    apps,
    totalBytes: sized ? totalBytes : null,
    unknownSizeItems: unknown,
    sourceCredentialKeyId: input.sourceCredentialKeyId
  };
}

export function requirementsFromManifest(manifest: Manifest): MigrationRequirements {
  const imageArtifacts = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const totalBytes = manifest.artifacts.reduce((sum, artifact) => sum + artifact.plaintextBytes, 0);

  return {
    scope: manifest.scope,
    operation: manifest.transfer.operation,
    source: compatSourceOf(manifest),
    migrationId: manifest.transfer.migrationId,
    apps: manifest.apps.map((app) => ({
      ref: app.ref,
      name: app.name,
      containerName: app.containerName,
      domain: app.domain,
      hostPorts: [],
      volumeNames: app.volumes.map((volume) => volume.name),
      imageTags: app.images.filter((image) => image.artifactId !== null).map((image) => image.tag),
      memoryLimitMb: null
    })),
    totalBytes: imageArtifacts.size > 0 ? totalBytes : null,
    unknownSizeItems: 0,
    sourceCredentialKeyId: null
  };
}

// --------------------------------------------------------------- ownership ----

/** True only if a destination resource was provably created by this migration. */
export function isOurs(marker: ResourceMarker | undefined, migrationId: string | null, sha?: string): boolean {
  if (!marker || migrationId === null || marker.migrationId !== migrationId) {
    return false;
  }

  return sha === undefined || marker.artifactSha256 === sha;
}

// --------------------------------------------------------------- conflicts ----

export type ConflictKind = "app-name" | "container-name" | "domain" | "host-port" | "volume" | "image";

export interface Conflict {
  kind: ConflictKind;
  /** The colliding name/domain/port. */
  name: string;
  appRef: string | null;
}

export function detectConflicts(requirements: MigrationRequirements, destination: DestinationDescriptor): Conflict[] {
  const conflicts: Conflict[] = [];
  const { inventory } = destination;
  const appNames = new Set(inventory.appNames.map((name) => name.toLowerCase()));
  const containers = new Map(inventory.containers.map((marker) => [marker.name, marker]));
  const domains = new Set(inventory.domains.map((domain) => domain.toLowerCase()));
  const ports = new Set(inventory.hostPorts);
  const volumes = new Map(inventory.volumes.map((marker) => [marker.name, marker]));
  const images = new Map(inventory.images.map((marker) => [marker.name, marker]));
  const migrationId = requirements.migrationId;

  for (const app of requirements.apps) {
    if (appNames.has(app.name.toLowerCase()) && !isOurs(containers.get(app.containerName), migrationId)) {
      conflicts.push({ kind: "app-name", name: app.name, appRef: app.ref });
    }
    if (containers.has(app.containerName) && !isOurs(containers.get(app.containerName), migrationId)) {
      conflicts.push({ kind: "container-name", name: app.containerName, appRef: app.ref });
    }
    if (app.domain && domains.has(app.domain.toLowerCase())) {
      conflicts.push({ kind: "domain", name: app.domain, appRef: app.ref });
    }
    for (const port of app.hostPorts) {
      if (ports.has(port)) {
        conflicts.push({ kind: "host-port", name: port, appRef: app.ref });
      }
    }
    for (const volume of app.volumeNames) {
      if (volumes.has(volume) && !isOurs(volumes.get(volume), migrationId)) {
        conflicts.push({ kind: "volume", name: volume, appRef: app.ref });
      }
    }
    for (const tag of app.imageTags) {
      if (images.has(tag) && !isOurs(images.get(tag), migrationId)) {
        // At preflight only the tag is known. Once a manifest is in hand, the import planner
        // recognises identical content (same image id) as already applied rather than a conflict.
        conflicts.push({ kind: "image", name: tag, appRef: app.ref });
      }
    }
  }

  return conflicts;
}

const CONFLICT_REMEDY: Record<ConflictKind, string> = {
  "app-name": "Rename the app on the destination, or remove the existing app if it is the same one.",
  "container-name": "Rename the app, or remove the existing container if it is stale.",
  domain: "Choose a different domain for the copy, or release this one on the destination first.",
  "host-port": "Pick a different host port, or free this one on the destination.",
  volume:
    "A volume with this name already exists and was not created by this migration. It will NOT be overwritten. " +
    "Rename it, or back it up and remove it deliberately.",
  image: "An image with this tag already exists with different content. It will NOT be overwritten."
};

const CONFLICT_TITLE: Record<ConflictKind, string> = {
  "app-name": "App names are free on the destination",
  "container-name": "Container names are free on the destination",
  domain: "Domains are free on the destination",
  "host-port": "Published host ports are free on the destination",
  volume: "Volume names are free on the destination",
  image: "Image tags are free on the destination"
};

// -------------------------------------------------------------- evaluation ----

const GIB = 1024 ** 3;
export const DISK_HEADROOM_FACTOR = 1.25;
export const DISK_HEADROOM_FIXED_BYTES = GIB;

export function requiredDiskBytes(totalBytes: number): number {
  return Math.ceil(totalBytes * DISK_HEADROOM_FACTOR) + DISK_HEADROOM_FIXED_BYTES;
}

export function evaluateDestination(
  requirements: MigrationRequirements,
  destination: DestinationDescriptor
): CheckResult[] {
  const checks: CheckResult[] = [];
  const dest = destination.platform;

  checks.push(
    dest.installed
      ? {
          id: "destination.platform.installed",
          title: "Destination runs ClovaForge",
          status: "pass",
          detail: `ClovaForge ${dest.version} (schema v${dest.schemaVersion}) on ${destination.server.hostname || "the destination"}.`
        }
      : {
          id: "destination.platform.installed",
          title: "Destination runs ClovaForge",
          status: "fail",
          detail: "No ClovaForge installation was found on the destination.",
          remediation: "Install ClovaForge on the destination first (installer/install.sh), then retry."
        }
  );

  const target: CompatTarget = {
    platformVersion: dest.version,
    schemaVersion: dest.schemaVersion,
    arch: destination.server.arch,
    supportedFormatVersions: dest.supportedFormatVersions
  };
  const issues = checkCompatibility(requirements.source, target);

  if (issues.length === 0) {
    checks.push({
      id: "destination.compatibility",
      title: "Versions and architecture are compatible",
      status: "pass",
      detail:
        `Source ${requirements.source.platformVersion} (schema v${requirements.source.schemaVersion}, ` +
        `${requirements.source.arch}) → destination ${dest.version} (schema v${dest.schemaVersion}, ${target.arch}).`
    });
  } else {
    for (const issue of issues) {
      checks.push({
        id: `destination.compatibility.${issue.code}`,
        title: "Versions and architecture are compatible",
        status: issue.severity,
        detail: issue.message,
        remediation: issue.severity === "fail" ? "Resolve the version or architecture difference before migrating." : undefined
      });
    }
  }

  checks.push(
    dest.capabilities.import
      ? {
          id: "destination.import.available",
          title: "Destination can import bundles",
          status: "pass",
          detail: "This ClovaForge build supports import."
        }
      : {
          id: "destination.import.available",
          title: "Destination can import bundles",
          status: "warn",
          detail:
            "This ClovaForge build can inspect and verify bundles but cannot import them yet. " +
            "Preflight results are accurate, but no data can be restored until import ships.",
          remediation: "Update ClovaForge on the destination once an import-capable release is available."
        }
  );

  // Disk
  if (requirements.totalBytes === null) {
    checks.push({
      id: "destination.resources.disk",
      title: "Destination has enough disk space",
      status: "skip",
      detail: "The amount of data to transfer could not be determined."
    });
  } else if (destination.server.freeDiskBytes === null) {
    checks.push({
      id: "destination.resources.disk",
      title: "Destination has enough disk space",
      status: "skip",
      detail: `Needs about ${formatBytes(requiredDiskBytes(requirements.totalBytes))}; the destination's free space could not be read.`
    });
  } else {
    const required = requiredDiskBytes(requirements.totalBytes);
    const free = destination.server.freeDiskBytes;
    const status = free < required ? "fail" : free < required * 1.5 ? "warn" : "pass";
    checks.push({
      id: "destination.resources.disk",
      title: "Destination has enough disk space",
      status,
      detail:
        `Needs about ${formatBytes(required)} (${formatBytes(requirements.totalBytes)} of data plus headroom); ` +
        `${formatBytes(free)} free.` +
        (requirements.unknownSizeItems > 0 ? ` ${requirements.unknownSizeItems} item(s) could not be sized.` : ""),
      remediation: status === "pass" ? undefined : `Free at least ${formatBytes(Math.max(required - free, 0))} on the destination.`,
      data: { requiredBytes: required, freeBytes: free }
    });
  }

  // Memory
  const limited = requirements.apps.filter((app) => app.memoryLimitMb !== null);
  if (limited.length > 0 && destination.server.memTotalBytes > 0) {
    const demand = limited.reduce((sum, app) => sum + (app.memoryLimitMb ?? 0), 0) * 1024 * 1024;
    const status = demand > destination.server.memTotalBytes ? "fail" : demand > destination.server.memTotalBytes * 0.7 ? "warn" : "pass";
    checks.push({
      id: "destination.resources.memory",
      title: "Destination has enough memory for the apps' limits",
      status,
      detail: `The apps' memory limits total ${formatBytes(demand)}; the destination has ${formatBytes(destination.server.memTotalBytes)}.`,
      remediation: status === "pass" ? undefined : "Choose a larger destination, or lower the apps' memory limits."
    });
  }

  // Platform scope replaces an installation: it must not land on a populated one.
  if (requirements.scope === "platform") {
    const populated = destination.inventory.appNames.length > 0;
    checks.push(
      populated
        ? {
            id: "destination.platform.empty",
            title: "Destination is a clean installation",
            status: "fail",
            detail: `The destination already manages ${destination.inventory.appNames.length} app(s). A full-server import replaces an installation and refuses to run over existing apps.`,
            remediation: "Use a freshly installed destination, or migrate individual apps instead."
          }
        : {
            id: "destination.platform.empty",
            title: "Destination is a clean installation",
            status: "pass",
            detail: "The destination has no managed apps."
          }
    );
  }

  // Name collisions, one check per kind.
  const conflicts = detectConflicts(requirements, destination);
  const kinds: ConflictKind[] = ["app-name", "container-name", "domain", "host-port", "volume", "image"];
  for (const kind of kinds) {
    const hits = conflicts.filter((conflict) => conflict.kind === kind);
    if (requirements.scope === "platform" && kind !== "volume" && kind !== "image" && hits.length === 0) {
      continue;
    }
    checks.push(
      hits.length === 0
        ? { id: `destination.conflicts.${kind}`, title: CONFLICT_TITLE[kind], status: "pass", detail: "No collisions." }
        : {
            id: `destination.conflicts.${kind}`,
            title: CONFLICT_TITLE[kind],
            status: "fail",
            detail: `${hits.length} collision(s): ${hits.map((hit) => hit.name).slice(0, 10).join(", ")}${hits.length > 10 ? ", …" : ""}.`,
            remediation: CONFLICT_REMEDY[kind],
            data: { count: hits.length }
          }
    );
  }

  // Credentials & keys
  if (requirements.scope === "platform") {
    checks.push({
      id: "destination.credentials.key",
      title: "Credential encryption key handling",
      status: "info",
      detail:
        "A full-server import brings the source's credential encryption key (inside the encrypted bundle) so every " +
        "stored credential keeps working. The destination's own key will be replaced.",
      remediation: undefined
    });
  } else {
    const same =
      requirements.sourceCredentialKeyId !== null &&
      destination.credentialKeyId !== null &&
      requirements.sourceCredentialKeyId === destination.credentialKeyId;
    checks.push({
      id: "destination.credentials.key",
      title: "Credential encryption key handling",
      status: "info",
      detail: same
        ? "Both servers share a credential key; credentials transfer as they are."
        : "The destination has its own credential key, which is never replaced. Credentials the app needs are " +
          "re-encrypted for the destination (the source's key is not transferred)."
    });
  }

  return checks;
}

// ------------------------------------------------------- untrusted input ----

const markerSchema = z.strictObject({
  name: z.string().max(512),
  migrationId: z.string().max(64).nullable(),
  artifactSha256: z.string().max(64).nullable(),
  contentId: z.string().max(200).nullable()
});

const descriptorSchema = z.strictObject({
  schemaVersion: z.literal(DESCRIPTOR_SCHEMA_VERSION),
  generatedAt: z.string().max(64),
  server: z.strictObject({
    serverId: z.string().max(64),
    hostname: z.string().max(255),
    arch: z.string().max(32),
    osDescription: z.string().max(255),
    dockerVersion: z.string().max(64),
    memTotalBytes: z.number().nonnegative(),
    cpuCount: z.number().nonnegative(),
    freeDiskBytes: z.number().nonnegative().nullable(),
    totalDiskBytes: z.number().nonnegative().nullable()
  }),
  platform: z.strictObject({
    installed: z.boolean(),
    version: z.string().max(64),
    schemaVersion: z.number().int().nonnegative(),
    supportedFormatVersions: z.array(z.number().int()).max(16),
    capabilities: z.strictObject({
      preflight: z.boolean(),
      bundleVerify: z.boolean(),
      export: z.boolean(),
      import: z.boolean()
    })
  }),
  credentialKeyId: z.string().max(64).nullable(),
  inventory: z.strictObject({
    appNames: z.array(z.string().max(255)).max(10000),
    containerNames: z.array(z.string().max(255)).max(10000),
    domains: z.array(z.string().max(255)).max(10000),
    hostPorts: z.array(z.string().max(32)).max(10000),
    credentialCount: z.number().int().nonnegative(),
    volumes: z.array(markerSchema).max(100000),
    images: z.array(markerSchema).max(100000),
    containers: z.array(markerSchema).max(100000)
  })
});

/** A descriptor arrives from another server, so it is validated strictly before use. */
export function parseDescriptor(input: unknown): DestinationDescriptor {
  return descriptorSchema.parse(input);
}
