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
 * Convenience alias for `resolveWithinRoot` when the caller already has
 * an EFFECTIVE, repo-relative path (e.g. one already produced by
 * `joinRepoPath` below) rather than a raw, subdirectory-relative one.
 */
export function resolveRepoPath(checkoutRoot: string, relativePath: string): string {
  return resolveWithinRoot(checkoutRoot, relativePath);
}

/**
 * The ONE canonical way to combine a source's `subdirectory` with a
 * repository-relative path configured against it — a Dockerfile path or
 * a build context. Both inputs are repo-relative strings (already
 * validated by the Zod schemas in schemas/source.ts: no leading "/", no
 * "..", no null bytes), NOT filesystem paths — this returns another
 * repo-relative string, still relative to the repository root, ready to
 * be passed to a GitHub API path-existence check or resolved against a
 * real checkout via resolveWithinRoot.
 *
 * `subdirectory` is repository-relative (requirement 1). `relativePath`
 * (a Dockerfile path or build context) is relative to `subdirectory`,
 * not the repository root (requirement 2/3) — "." means "the
 * subdirectory itself", not the repository root (requirement 4):
 *   joinRepoPath(".", "Dockerfile")               -> "Dockerfile"
 *   joinRepoPath("tools/x", ".")                   -> "tools/x"
 *   joinRepoPath("tools/x", "Dockerfile")          -> "tools/x/Dockerfile"
 *   joinRepoPath("tools/x", "docker/Dockerfile")   -> "tools/x/docker/Dockerfile"
 *
 * Duplicate slashes and a leading "./" are collapsed safely (requirement
 * 6) — but this NEVER silently absorbs an escape attempt: a ".."
 * segment or a leading "/" in either input throws PathSecurityError
 * rather than being stripped or rewritten into some other, still-valid
 * path (requirement 5 and 7 — invalid input is rejected outright, not
 * silently reinterpreted). Schema validation should already reject
 * these before a value ever reaches here; this is defense-in-depth
 * against a caller that skipped it, same rationale as
 * resolveWithinRoot's own doc above.
 *
 * This is the single implementation used by repository inspection,
 * saved-source validation, and the actual build (build-strategy.ts) —
 * a second, divergent join must never be added; import this instead.
 */
export function joinRepoPath(subdirectory: string, relativePath: string): string {
  for (const [label, value] of [
    ["subdirectory", subdirectory],
    ["path", relativePath]
  ] as const) {
    if (value.startsWith("/")) {
      throw new PathSecurityError(`${label} must not be an absolute path: "${value}"`);
    }
    if (value.split("/").some((segment) => segment === "..")) {
      throw new PathSecurityError(`${label} must not contain ".." segments: "${value}"`);
    }
  }

  const collapse = (value: string): string =>
    value
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== ".")
      .join("/");

  const normalizedSubdirectory = collapse(subdirectory);
  const normalizedRelative = collapse(relativePath);

  if (!normalizedRelative) {
    return normalizedSubdirectory || ".";
  }
  if (!normalizedSubdirectory) {
    return normalizedRelative;
  }
  return `${normalizedSubdirectory}/${normalizedRelative}`;
}
