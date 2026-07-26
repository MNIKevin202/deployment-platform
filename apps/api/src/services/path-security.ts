import { resolve, sep } from "node:path";

/**
 * Thrown whenever a repository-relative path — subdirectory, Dockerfile
 * path, build context, static output directory — cannot be safely
 * resolved inside a checkout root. Callers should treat this exactly
 * like a validation error: it must never reach the browser as a raw
 * stack trace or expose the real host filesystem path.
 */
export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

/**
 * The one place that turns a repository-relative path into a real
 * filesystem path. Every caller that is about to read, write, or pass a
 * path to `git`/`docker build` inside a checkout must go through this —
 * it is deliberately redundant with the Zod path schemas in
 * schemas/source.ts (which reject `..`, absolute paths, null bytes, and
 * percent-encoded traversal at the API boundary): this function is the
 * defense-in-depth check against the *resolved, real* path, so a bug or
 * omission in the regex-based schema can never turn into an actual
 * filesystem escape.
 */
export function resolveWithinRoot(rootDir: string, relativePath: string): string {
  if (relativePath.includes("\0")) {
    throw new PathSecurityError("Path must not contain null bytes");
  }

  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(resolvedRoot, relativePath);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new PathSecurityError("Path resolves outside the repository checkout");
  }

  return resolvedTarget;
}

/**
 * Convenience wrapper for the common case of resolving a path relative
 * to a subdirectory that has *itself* already been validated with
 * `resolveWithinRoot` — e.g. a Dockerfile path is relative to the
 * repository root, not to the configured subdirectory, so both are
 * checked independently against the same root rather than nesting them.
 */
export function resolveRepoPath(checkoutRoot: string, relativePath: string): string {
  return resolveWithinRoot(checkoutRoot, relativePath);
}
