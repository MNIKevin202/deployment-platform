import { z } from "zod";
import { containerPortSchema } from "./app.js";

// GitHub-compatible owner (user/org) rules: alphanumeric and single
// hyphens, no leading/trailing hyphen, 1-39 characters, no slash.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// GitHub-compatible repository name rules: alphanumeric, dot, hyphen,
// underscore, 1-100 characters, no slash.
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function hasNoSlashOrTraversal(value: string): boolean {
  return !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

function looksLikeUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || value.startsWith("www.");
}

export const repositoryOwnerSchema = z
  .string()
  .min(1, "Owner is required")
  .max(39, "Owner is too long")
  .refine((value) => !looksLikeUrl(value), "Enter the owner name, not a URL")
  .refine(hasNoSlashOrTraversal, "Owner must not contain a slash")
  .regex(OWNER_PATTERN, "Owner contains characters GitHub does not allow");

export const repositoryNameSchema = z
  .string()
  .min(1, "Repository name is required")
  .max(100, "Repository name is too long")
  .refine((value) => !looksLikeUrl(value), "Enter the repository name, not a URL")
  .refine(hasNoSlashOrTraversal, "Repository name must not contain a slash")
  .regex(REPO_NAME_PATTERN, "Repository name contains characters GitHub does not allow");

const MAX_BRANCH_LENGTH = 255;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

export const branchNameSchema = z
  .string()
  .min(1, "Branch is required")
  .max(MAX_BRANCH_LENGTH, "Branch name is too long")
  .refine((value) => !hasControlCharacters(value), "Branch name contains control characters")
  .refine((value) => !value.startsWith("-"), "Branch name must not start with a dash")
  .refine((value) => !value.includes(".."), 'Branch name must not contain ".."')
  .refine((value) => !value.includes(" "), "Branch name must not contain spaces")
  .refine((value) => !value.endsWith("/"), "Branch name must not end with a slash")
  .refine((value) => !value.endsWith(".lock"), 'Branch name must not end with ".lock"');

export const deploymentModeSchema = z.enum(["prebuilt-image", "dockerfile"]);

const MAX_REPO_RELATIVE_PATH_LENGTH = 255;

// "?" and "#" would be interpreted as the start of a query string or
// fragment if this path were ever concatenated into a URL; backslash is
// rejected outright since GitHub repository paths only ever use "/".
const FORBIDDEN_PATH_CHAR_PATTERN = /[?#\\]/;

// Catches percent-encoded traversal/separator characters — %2e ("."),
// %2f ("/"), %5c ("\") — case-insensitively, so an encoded "%2e%2e%2f"
// can't smuggle a traversal segment past the plain-text checks below.
const PERCENT_ENCODED_SEPARATOR_PATTERN = /%2e|%2f|%5c/i;

function hasForbiddenCharacters(value: string): boolean {
  return FORBIDDEN_PATH_CHAR_PATTERN.test(value);
}

function hasPercentEncodedSeparatorOrTraversal(value: string): boolean {
  return PERCENT_ENCODED_SEPARATOR_PATTERN.test(value);
}

/** Catches "a//b", a leading "/" already-rejected separately, and a trailing "/". */
function hasEmptySegment(value: string): boolean {
  return value.split("/").some((segment) => segment.length === 0);
}

function hasDotSegment(value: string): boolean {
  return value.split("/").some((segment) => segment === ".");
}

function hasDotDotSegment(value: string): boolean {
  return value.split("/").some((segment) => segment === "..");
}

/**
 * Shared shape for a repository-relative path (Dockerfile path or build
 * context): no leading slash (this is relative to the repo root, not an
 * absolute container path), no null bytes/control characters, no URL
 * syntax, no query/fragment/backslash characters, and no percent-encoded
 * traversal. Segment-level rules (".", "..", empty/trailing segments)
 * differ between a file path and a directory, so those are layered on
 * separately below rather than forced into one shared rule.
 */
function baseRepoRelativePathSchema(fieldLabel: string) {
  return z
    .string()
    .min(1, `${fieldLabel} is required`)
    .max(MAX_REPO_RELATIVE_PATH_LENGTH, `${fieldLabel} is too long`)
    .refine((value) => !value.includes("\0"), `${fieldLabel} must not contain null bytes`)
    .refine((value) => !hasControlCharacters(value), `${fieldLabel} contains control characters`)
    .refine((value) => !value.startsWith("/"), `${fieldLabel} must be relative to the repository root`)
    .refine((value) => !looksLikeUrl(value), `${fieldLabel} must be a path, not a URL`)
    .refine(
      (value) => !hasForbiddenCharacters(value),
      `${fieldLabel} must not contain "?", "#", or "\\"`
    )
    .refine(
      (value) => !hasPercentEncodedSeparatorOrTraversal(value),
      `${fieldLabel} must not contain percent-encoded path separators`
    )
    .refine((value) => !hasDotDotSegment(value), `${fieldLabel} must not contain ".." segments`);
}

export const dockerfilePathSchema = baseRepoRelativePathSchema("Dockerfile path")
  .refine(
    (value) => !hasEmptySegment(value),
    "Dockerfile path must not contain empty or trailing path segments"
  )
  .refine((value) => !hasDotSegment(value), 'Dockerfile path must not contain a "." segment');

export const buildContextSchema = baseRepoRelativePathSchema("Build context")
  .refine(
    (value) => value === "." || !hasEmptySegment(value),
    "Build context must not contain empty or trailing path segments"
  )
  .refine(
    (value) => value === "." || !hasDotSegment(value),
    'Build context must not contain a "." segment except as the whole value'
  );

// Subdirectory shares every rule with build context (repo-relative
// directory, "." meaning the repo root) — deliberately the same schema
// under a distinct exported name so call sites read clearly and so the
// two can diverge later without a breaking rename.
export const subdirectorySchema = buildContextSchema;

export const DEFAULT_DOCKERFILE_PATH = "Dockerfile";
export const DEFAULT_BUILD_CONTEXT = ".";
export const DEFAULT_SUBDIRECTORY = ".";

// User-selectable build strategies for Phase 11 GitHub deployment.
// "unsupported" is deliberately not selectable here — it is only ever a
// detection *result* (e.g. a Docker Compose project), never a value a
// user can request.
export const buildStrategySchema = z.enum(["dockerfile", "nodejs", "static"]);

// "manual" when the operator typed the port themselves; otherwise the
// exact PortDetectionSource string the operator accepted from an
// inspection result (see repository-inspection-service.ts). The server
// never trusts this as the *value* of the port — containerPort is still
// independently validated by containerPortSchema — this only records
// *how* that already-validated value was arrived at, for display.
export const containerPortSourceSchema = z.enum([
  "manual",
  "dockerfile-expose",
  "dockerfile-env",
  "package-script",
  "source-code",
  "framework-default",
  "platform-default"
]);

export const containerPortConfidenceSchema = z.enum(["high", "medium", "low", "none"]);

export const appSourceConfigSchema = z
  .object({
    repositoryOwner: repositoryOwnerSchema,
    repositoryName: repositoryNameSchema,
    branch: branchNameSchema,
    subdirectory: subdirectorySchema.optional().default(DEFAULT_SUBDIRECTORY),
    deploymentMode: deploymentModeSchema,
    dockerfilePath: dockerfilePathSchema.optional().default(DEFAULT_DOCKERFILE_PATH),
    buildContext: buildContextSchema.optional().default(DEFAULT_BUILD_CONTEXT),
    containerPort: containerPortSchema.optional(),
    containerPortSource: containerPortSourceSchema.optional(),
    containerPortConfidence: containerPortConfidenceSchema.optional(),
    autoDeploy: z.boolean().optional().default(false),
    // The operator's explicit strategy choice — omitted/null means
    // "follow whatever inspection recommends" (unchanged default
    // behavior). Inspection recommendations are advisory, not
    // mandatory: an operator may select "dockerfile" even when
    // inspection recommended "nodejs" (or vice versa), and this is the
    // one field that carries that choice through to the actual deploy.
    selectedStrategy: buildStrategySchema.nullable().optional()
  })
  .strict();

export type AppSourceConfigInput = z.infer<typeof appSourceConfigSchema>;

export const repositoryInspectionRequestSchema = z
  .object({
    repositoryOwner: repositoryOwnerSchema,
    repositoryName: repositoryNameSchema,
    branch: branchNameSchema,
    subdirectory: subdirectorySchema.optional().default(DEFAULT_SUBDIRECTORY)
  })
  .strict();

export type RepositoryInspectionRequestInput = z.infer<typeof repositoryInspectionRequestSchema>;

export const githubDeployRequestSchema = z
  .object({
    /** Optional confirmation of the commit the operator saw in the UI —
     * if provided and it no longer matches the branch tip, the deploy is
     * rejected rather than silently deploying a different commit. */
    expectedCommitSha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/i, "Expected commit SHA must look like a Git SHA")
      .optional()
  })
  .strict();

export type GithubDeployRequestInput = z.infer<typeof githubDeployRequestSchema>;
