import type { WizardEnvVarInput, WizardVolumeInput } from "../types/api";

export const APP_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const VOLUME_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,62}$/;
const CONTAINER_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

/** Mirrors apps/api/src/domain.ts's SAFE_DOMAIN — at least two DNS labels. */
const SAFE_DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Mirrors the server's reserved-path list so the wizard can reject an
 * obviously-invalid path before submitting, without duplicating the
 * server's authority to reject it — the server always re-validates. */
const RESERVED_EXACT_PATHS = new Set(["/", "/var"]);
const RESERVED_ROOT_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/root",
  "/run",
  "/var/run"
];

export function isValidAppName(name: string): boolean {
  return name.length >= 2 && name.length <= 40 && APP_NAME_PATTERN.test(name);
}

export function isValidImage(image: string): boolean {
  return image.trim().length > 0 && image.trim().length <= 200;
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function isValidEnvKey(key: string): boolean {
  return key.length > 0 && key.length <= 256 && ENV_KEY_PATTERN.test(key);
}

export function isValidVolumeName(name: string): boolean {
  return VOLUME_NAME_PATTERN.test(name);
}

/**
 * Client-side approximation of the server's validateCustomDomain
 * (apps/api/src/domain.ts) — good enough to catch an obviously invalid
 * domain before submitting, but never authoritative: the server always
 * re-validates and normalizes, and its rejection message is what's shown
 * on a 400 regardless of what this function said.
 */
export function isValidCustomDomain(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;

  const value = trimmed.toLowerCase();
  if (
    value.includes("://") ||
    value.includes("@") ||
    value.includes("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("*") ||
    value.includes(":")
  ) {
    return false;
  }

  const withoutTrailingDot = value.endsWith(".") && !value.endsWith("..") ? value.slice(0, -1) : value;
  if (withoutTrailingDot.length === 0 || withoutTrailingDot.startsWith(".")) return false;
  if (withoutTrailingDot === "localhost" || withoutTrailingDot.endsWith(".localhost")) return false;
  if (IPV4_PATTERN.test(withoutTrailingDot)) return false;

  return SAFE_DOMAIN_PATTERN.test(withoutTrailingDot);
}

export function isReservedContainerPath(path: string): boolean {
  if (RESERVED_EXACT_PATHS.has(path)) {
    return true;
  }

  return RESERVED_ROOT_PATHS.some(
    (root) => path === root || path.startsWith(`${root}/`)
  );
}

export function isValidContainerPath(path: string): boolean {
  if (path.length < 2 || path.length > 255) {
    return false;
  }

  if (!CONTAINER_PATH_PATTERN.test(path)) {
    return false;
  }

  if (path.includes("..") || path.endsWith("/")) {
    return false;
  }

  return !isReservedContainerPath(path);
}

/** Returns an error message, or null if every variable is valid and no key repeats. */
export function validateEnvVars(vars: WizardEnvVarInput[]): string | null {
  const seenKeys = new Set<string>();

  for (const envVar of vars) {
    if (!isValidEnvKey(envVar.key)) {
      return `"${envVar.key || "(empty)"}" is not a valid variable name. Use letters, numbers, and underscores, and don't start with a number.`;
    }

    if (seenKeys.has(envVar.key)) {
      return `"${envVar.key}" is used more than once.`;
    }

    seenKeys.add(envVar.key);
  }

  return null;
}

/** Returns an error message, or null if every mount is valid and nothing collides. */
export function validateStorageMounts(mounts: WizardVolumeInput[]): string | null {
  const seenPaths = new Set<string>();
  const seenVolumeNames = new Set<string>();

  for (const mount of mounts) {
    if (!isValidContainerPath(mount.containerPath)) {
      return `"${mount.containerPath || "(empty)"}" is not a usable container path.`;
    }

    if (seenPaths.has(mount.containerPath)) {
      return `"${mount.containerPath}" is mounted more than once.`;
    }

    seenPaths.add(mount.containerPath);

    if (mount.volumeName) {
      if (!isValidVolumeName(mount.volumeName)) {
        return `"${mount.volumeName}" is not a valid volume name. Use lowercase letters, numbers, hyphens, and underscores, starting with a letter.`;
      }

      if (seenVolumeNames.has(mount.volumeName)) {
        return `Volume name "${mount.volumeName}" is used more than once.`;
      }

      seenVolumeNames.add(mount.volumeName);
    }
  }

  return null;
}
