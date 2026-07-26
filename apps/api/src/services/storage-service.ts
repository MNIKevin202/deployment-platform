import type { StoredAppVolume } from "../volume-database.js";

const RESERVED_VOLUME_PREFIX = "deployment-platform-";

/** Volumes the platform itself owns — never reusable through this feature. */
const RESERVED_VOLUME_NAMES = new Set([
  "deployment-platform-api-data",
  "deployment-platform-caddy-data",
  "deployment-platform-caddy-config"
]);

export function isReservedVolumeName(name: string): boolean {
  return (
    RESERVED_VOLUME_NAMES.has(name) || name.startsWith(RESERVED_VOLUME_PREFIX)
  );
}

const MAX_GENERATED_NAME_LENGTH = 60;

/**
 * Deterministic default volume name from the app name and container path,
 * e.g. ("sqlite-test", "/data") -> "sqlite-test-data". Collision handling
 * (appending a numeric suffix if this name is already taken) is the
 * caller's responsibility since that requires a database lookup.
 */
export function buildDefaultVolumeName(
  appName: string,
  containerPath: string
): string {
  const sanitizedPath = containerPath
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const suffix = sanitizedPath.length > 0 ? sanitizedPath : "data";

  return `${appName}-${suffix}`.slice(0, MAX_GENERATED_NAME_LENGTH);
}

const MAX_NAME_GENERATION_ATTEMPTS = 25;

/**
 * Deterministic base name, with a numeric suffix appended only if that
 * exact name is already taken (volume names are globally unique in
 * Docker). `isNameTaken` is injected so callers can check both the
 * database and any names already claimed earlier in the same batch (e.g.
 * multiple mounts being created together in one wizard submission, before
 * any of them are persisted).
 */
export function generateUniqueVolumeName(
  appName: string,
  containerPath: string,
  isNameTaken: (name: string) => boolean
): string {
  const base = buildDefaultVolumeName(appName, containerPath);

  if (!isNameTaken(base)) {
    return base;
  }

  for (let attempt = 2; attempt <= MAX_NAME_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = `${base}-${attempt}`;

    if (!isNameTaken(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to generate a unique volume name");
}

export interface DockerMountConfig {
  Type: "volume";
  Source: string;
  Target: string;
  ReadOnly: boolean;
}

/**
 * Structured Docker Mounts entries (never Binds/host paths) for a
 * container's HostConfig — used identically at app creation and at
 * redeploy so both stay in sync.
 */
export function buildVolumeMounts(
  volumes: StoredAppVolume[]
): DockerMountConfig[] {
  return volumes.map((volume) => ({
    Type: "volume",
    Source: volume.volumeName,
    Target: volume.containerPath,
    ReadOnly: volume.readOnly
  }));
}
