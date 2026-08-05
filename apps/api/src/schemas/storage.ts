import { z } from "zod";

export const VOLUME_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,62}$/;
const CONTAINER_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

/**
 * Paths that are only dangerous as an exact mount target — subdirectories
 * beneath them are ordinary, commonly-used application storage locations
 * (e.g. /var/lib/myapp) and must stay usable.
 */
const RESERVED_EXACT_PATHS = new Set(["/", "/var"]);

/**
 * Core system/kernel/platform directory trees. Reserved entirely —
 * mounting at the root itself or anywhere beneath it is blocked, since
 * these paths have no legitimate use as application storage at any depth.
 */
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
  "/run",
  "/var/run"
];

/*
 * `/root` is deliberately NOT in the list above. It is the root user's home
 * directory, not a system/kernel tree, and several self-hosted images keep
 * their generated state there — RustDesk's server writes its signing keypair
 * to /root and would lose every client's trust on each redeploy without a
 * volume there.
 *
 * The panel still refuses a hand-typed /root (see isValidContainerPath in
 * apps/web/src/lib/wizardValidation.ts); only a curated template's own
 * declared volume may use it. That distinction can't be re-checked here,
 * since a template install arrives as an ordinary wizard request and the API
 * has no copy of the template catalog — so this endpoint accepts /root and
 * the vetting lives in the panel.
 */

/**
 * Named volumes can't reach arbitrary host files (there is no host bind
 * mount in this feature), so this is defense-in-depth against
 * confusing/harmful mount targets rather than a host-filesystem exposure
 * risk.
 */
function isDangerousContainerPath(path: string): boolean {
  if (RESERVED_EXACT_PATHS.has(path)) {
    return true;
  }

  return RESERVED_ROOT_PATHS.some(
    (root) => path === root || path.startsWith(`${root}/`)
  );
}

export const containerPathSchema = z
  .string()
  .min(2, "Path is required")
  .max(255, "Path is too long")
  .regex(
    CONTAINER_PATH_PATTERN,
    "Path must be absolute and use only letters, numbers, dots, dashes, underscores, and slashes"
  )
  .refine((path) => !path.includes(".."), 'Path must not contain ".."')
  .refine(
    (path) => path === "/" || !path.endsWith("/"),
    "Path must not end with a trailing slash"
  )
  .refine(
    (path) => !isDangerousContainerPath(path),
    "This path is reserved and cannot be used for storage"
  );

export const volumeNameSchema = z
  .string()
  .min(2, "Volume name is required")
  .max(63, "Volume name is too long")
  .regex(
    VOLUME_NAME_PATTERN,
    "Volume name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores"
  );

export const createVolumeSchema = z.object({
  containerPath: containerPathSchema,
  volumeName: volumeNameSchema.optional(),
  readOnly: z.boolean().optional().default(false)
});

export const updateVolumeSchema = z
  .object({
    containerPath: containerPathSchema.optional(),
    readOnly: z.boolean().optional()
  })
  .refine(
    (data) => data.containerPath !== undefined || data.readOnly !== undefined,
    "At least one field must be provided"
  );
