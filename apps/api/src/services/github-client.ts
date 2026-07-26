import {
  SourceClientError,
  type ListPageOptions,
  type ListRepositoriesOptions,
  type SourceAccount,
  type SourceBranch,
  type SourceClientLogEvent,
  type SourceClientLogger,
  type SourceClientPage,
  type SourceCommit,
  type SourceProviderClient,
  type SourceRepository
} from "./source-provider.js";

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "DeploymentPlatform-Integration/1.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 50;

function clampPerPage(perPage: number | undefined): number {
  if (!perPage || !Number.isFinite(perPage) || perPage < 1) {
    return DEFAULT_PER_PAGE;
  }

  return Math.min(Math.floor(perPage), MAX_PER_PAGE);
}

function clampPage(page: number | undefined): number {
  if (!page || !Number.isFinite(page) || page < 1) {
    return 1;
  }

  return Math.floor(page);
}

function endpointCategory(path: string): string {
  if (path === "/user") return "user";
  if (path === "/user/repos") return "repositories";
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return "repository";
  if (/\/branches\/[^/]+$/.test(path)) return "branch";
  if (/\/branches$/.test(path)) return "branches";
  if (/\/commits$/.test(path)) return "commits";
  if (/\/contents\//.test(path)) return "contents";
  return "other";
}

function hasNextPage(linkHeader: string | null): boolean {
  if (!linkHeader) {
    return false;
  }

  return linkHeader.split(",").some((part) => part.includes('rel="next"'));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// ---------- URL construction ----------
//
// Every dynamic value that becomes part of the URL *path* is encoded
// individually before being concatenated — never interpolated raw. Query
// values (branch/ref for the commits and contents endpoints) are handed to
// URLSearchParams instead, which encodes them itself; nothing here encodes
// a value twice.

/** Encodes owner/repo as a single opaque path segment each. */
function repoBasePath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Encodes a repository-relative *file* path for use in a URL path,
 * preserving "/" as the separator between real segments while encoding
 * the content of each segment — so a segment containing characters like
 * "#" or "?" can never be mistaken for a fragment or query string, and a
 * segment can never introduce an extra "/" of its own.
 */
function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Encodes a branch name as a single opaque path segment. Branch names may
 * themselves legitimately contain "/" (e.g. "feature/thing"); GitHub's
 * per-branch endpoint expects that encoded as %2F rather than treated as
 * additional path segments, so — unlike a file path — the whole name is
 * encoded as one unit.
 */
function encodeBranchSegment(branch: string): string {
  return encodeURIComponent(branch);
}

interface PerformedRequest {
  response: Response;
  emit: (status: number | null, classification: SourceClientLogEvent["errorClassification"]) => void;
}

/**
 * Everything common to every GitHub call: timeout enforcement via
 * AbortController (a single attempt, never retried), required headers,
 * and turning a non-2xx response into a classified `SourceClientError`
 * before the caller ever has to look at the response body. Returns the
 * still-open `response` so the two response-mode-specific wrappers below
 * can decide what to do with the body.
 */
async function performGithubRequest(
  token: string,
  path: string,
  query: Record<string, string | number | undefined> | undefined,
  logger: SourceClientLogger | undefined,
  timeoutMs: number
): Promise<PerformedRequest> {
  const url = new URL(`${GITHUB_API_BASE}${path}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  const category = endpointCategory(path);
  const emit = (status: number | null, classification: SourceClientLogEvent["errorClassification"]) => {
    logger?.log({
      provider: "github",
      endpointCategory: category,
      status,
      durationMs: Date.now() - start,
      errorClassification: classification
    });
  };

  let response: Response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT
      },
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      emit(null, "network-timeout");
      throw new SourceClientError("network-timeout", "GitHub request timed out");
    }

    emit(null, "service-error");
    throw new SourceClientError("service-error", "Unable to reach GitHub");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
    const classification = classifyErrorStatus(response.status, rateLimitRemaining);
    emit(response.status, classification);
    // The failing response's body is never read here — classification is
    // based entirely on status/headers, so nothing about the body (which
    // could itself be large or, for the contents endpoint, contain file
    // data) is ever downloaded on a failure path either.
    await discardBody(response);
    throw new SourceClientError(classification, describeError(classification));
  }

  return { response, emit };
}

/** Releases a response body without reading it, for endpoints where only success/failure matters. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup only — must never surface as a request failure.
  }
}

interface GithubJsonResult {
  status: number;
  json: unknown;
  linkHeader: string | null;
}

/** For endpoints whose response body is needed and safe to parse as JSON. */
async function githubRequestJson(
  token: string,
  path: string,
  query: Record<string, string | number | undefined> | undefined,
  logger: SourceClientLogger | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<GithubJsonResult> {
  const { response, emit } = await performGithubRequest(token, path, query, logger, timeoutMs);

  let json: unknown = null;

  try {
    // 204 No Content and similar have no body to parse.
    const text = await response.text();
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    emit(response.status, "malformed-response");
    throw new SourceClientError("malformed-response", "GitHub returned an unexpected response");
  }

  emit(response.status, null);

  return { status: response.status, json, linkHeader: response.headers.get("link") };
}

interface GithubNoBodyResult {
  status: number;
}

/**
 * For endpoints where only the outcome (success/failure, status code)
 * matters — the response body is never read, parsed, or retained. Used by
 * `pathExists()` so a plain existence check never materializes the
 * Contents API's file metadata/base64 content.
 */
async function githubRequestNoBody(
  token: string,
  path: string,
  query: Record<string, string | number | undefined> | undefined,
  logger: SourceClientLogger | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<GithubNoBodyResult> {
  const { response, emit } = await performGithubRequest(token, path, query, logger, timeoutMs);

  await discardBody(response);
  emit(response.status, null);

  return { status: response.status };
}

function classifyErrorStatus(
  status: number,
  rateLimitRemaining: string | null
): Exclude<SourceClientLogEvent["errorClassification"], null> {
  if (status === 401) {
    return "invalid-token";
  }

  if (status === 403) {
    return rateLimitRemaining === "0" ? "rate-limited" : "insufficient-permissions";
  }

  if (status === 404) {
    return "not-found";
  }

  if (status === 429) {
    return "rate-limited";
  }

  if (status >= 500) {
    return "service-error";
  }

  return "service-error";
}

function describeError(kind: Exclude<SourceClientLogEvent["errorClassification"], null>): string {
  switch (kind) {
    case "invalid-token":
      return "GitHub rejected this token. It may be invalid, expired, or revoked.";
    case "insufficient-permissions":
      return "This token does not have permission to access this GitHub resource.";
    case "rate-limited":
      return "GitHub rate limit reached. Try again shortly.";
    case "not-found":
      return "The requested GitHub resource was not found.";
    case "network-timeout":
      return "GitHub request timed out.";
    case "malformed-response":
      return "GitHub returned an unexpected response.";
    case "service-error":
    default:
      return "Unable to reach GitHub right now.";
  }
}

// ---------- Strict normalization ----------
//
// Every field an internal caller might reasonably rely on (an id used as a
// database key, a URL rendered as a link, a SHA persisted as "the
// validated commit") is required and validated here. A missing or
// malformed required field throws `malformed-response` rather than
// silently substituting an empty string — better to fail loudly than to
// persist or display a value that looks real but isn't.

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SourceClientError("malformed-response", `GitHub response is missing "${field}"`);
  }

  return value;
}

function requireRepositoryId(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  throw new SourceClientError("malformed-response", 'GitHub response is missing "id"');
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function requireSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new SourceClientError("malformed-response", `GitHub response has an invalid "${field}"`);
  }

  return value;
}

function requireHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SourceClientError("malformed-response", `GitHub response is missing "${field}"`);
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new SourceClientError("malformed-response", `GitHub response has an invalid "${field}"`);
  }

  if (parsed.protocol !== "https:") {
    throw new SourceClientError("malformed-response", `GitHub response has an invalid "${field}"`);
  }

  return value;
}

function normalizeAccount(raw: unknown): SourceAccount {
  if (!raw || typeof raw !== "object") {
    throw new SourceClientError("malformed-response", "GitHub response is missing the account body");
  }

  const obj = raw as Record<string, unknown>;
  const username = requireNonEmptyString(obj.login, "login");
  const htmlUrl =
    typeof obj.html_url === "string" && obj.html_url.length > 0
      ? requireHttpsUrl(obj.html_url, "html_url")
      : `https://github.com/${username}`;

  return { username, htmlUrl };
}

function normalizeRepository(raw: unknown): SourceRepository {
  if (!raw || typeof raw !== "object") {
    throw new SourceClientError("malformed-response", "GitHub response is missing a repository body");
  }

  const obj = raw as Record<string, unknown>;
  const ownerObj = obj.owner as Record<string, unknown> | undefined;

  const id = requireRepositoryId(obj.id);
  const owner = requireNonEmptyString(ownerObj?.login, "owner.login");
  const name = requireNonEmptyString(obj.name, "name");
  const fullName = typeof obj.full_name === "string" && obj.full_name.length > 0 ? obj.full_name : `${owner}/${name}`;
  const defaultBranch = requireNonEmptyString(obj.default_branch, "default_branch");
  const htmlUrl = requireHttpsUrl(obj.html_url, "html_url");

  return {
    id,
    owner,
    name,
    fullName,
    // Defaults to false if the field is missing or not a boolean — this
    // only affects a display badge; it never governs what GitHub actually
    // permits, so a conservative default here can't create a false sense
    // of access.
    private: obj.private === true,
    archived: obj.archived === true,
    description: asString(obj.description),
    defaultBranch,
    htmlUrl,
    pushedAt: asString(obj.pushed_at),
    updatedAt: asString(obj.updated_at)
  };
}

function normalizeBranch(raw: unknown): SourceBranch {
  if (!raw || typeof raw !== "object") {
    throw new SourceClientError("malformed-response", "GitHub response is missing a branch body");
  }

  const obj = raw as Record<string, unknown>;
  const commit = obj.commit as Record<string, unknown> | undefined;

  return {
    name: requireNonEmptyString(obj.name, "name"),
    commitSha: requireSha(commit?.sha, "commit.sha"),
    protected: obj.protected === true
  };
}

function normalizeCommit(raw: unknown): SourceCommit {
  if (!raw || typeof raw !== "object") {
    throw new SourceClientError("malformed-response", "GitHub response is missing a commit body");
  }

  const obj = raw as Record<string, unknown>;
  const commit = obj.commit as Record<string, unknown> | undefined;
  const author = commit?.author as Record<string, unknown> | undefined;
  const ghAuthor = obj.author as Record<string, unknown> | undefined;

  return {
    sha: requireSha(obj.sha, "sha"),
    // GitHub can legitimately return an empty commit message; author
    // fields are nullable when GitHub can't link the commit to an account.
    message: asString(commit?.message) ?? "",
    authorName: asString(author?.name) ?? asString(ghAuthor?.login),
    authorDate: asString(author?.date),
    htmlUrl: requireHttpsUrl(obj.html_url, "html_url")
  };
}

export function createGithubClient(logger?: SourceClientLogger): SourceProviderClient {
  return {
    provider: "github",

    async validateCredential(token: string): Promise<SourceAccount> {
      const result = await githubRequestJson(token, "/user", undefined, logger);
      return normalizeAccount(result.json);
    },

    async listRepositories(
      token: string,
      options?: ListRepositoriesOptions
    ): Promise<SourceClientPage<SourceRepository>> {
      // GitHub's /user/repos listing has no repository-name search
      // parameter — only pagination/sort/affiliation are sent. Filtering
      // by name is the frontend's job, over whatever has already loaded.
      const result = await githubRequestJson(
        token,
        "/user/repos",
        {
          per_page: clampPerPage(options?.perPage),
          page: clampPage(options?.page),
          sort: "pushed",
          affiliation: "owner,collaborator,organization_member"
        },
        logger
      );

      if (!Array.isArray(result.json)) {
        throw new SourceClientError("malformed-response", "GitHub returned an unexpected repository list");
      }

      return { items: result.json.map(normalizeRepository), hasMore: hasNextPage(result.linkHeader) };
    },

    async getRepository(token: string, owner: string, repo: string): Promise<SourceRepository> {
      const result = await githubRequestJson(token, repoBasePath(owner, repo), undefined, logger);
      return normalizeRepository(result.json);
    },

    async listBranches(
      token: string,
      owner: string,
      repo: string,
      options?: ListPageOptions
    ): Promise<SourceClientPage<SourceBranch>> {
      const result = await githubRequestJson(
        token,
        `${repoBasePath(owner, repo)}/branches`,
        { per_page: clampPerPage(options?.perPage), page: clampPage(options?.page) },
        logger
      );

      if (!Array.isArray(result.json)) {
        throw new SourceClientError("malformed-response", "GitHub returned an unexpected branch list");
      }

      return { items: result.json.map(normalizeBranch), hasMore: hasNextPage(result.linkHeader) };
    },

    async listCommits(
      token: string,
      owner: string,
      repo: string,
      branch: string,
      options?: ListPageOptions
    ): Promise<SourceClientPage<SourceCommit>> {
      const result = await githubRequestJson(
        token,
        `${repoBasePath(owner, repo)}/commits`,
        {
          sha: branch,
          per_page: clampPerPage(options?.perPage),
          page: clampPage(options?.page)
        },
        logger
      );

      if (!Array.isArray(result.json)) {
        throw new SourceClientError("malformed-response", "GitHub returned an unexpected commit list");
      }

      return { items: result.json.map(normalizeCommit), hasMore: hasNextPage(result.linkHeader) };
    },

    async resolveBranchCommit(token: string, owner: string, repo: string, branch: string): Promise<string> {
      const result = await githubRequestJson(
        token,
        `${repoBasePath(owner, repo)}/branches/${encodeBranchSegment(branch)}`,
        undefined,
        logger
      );

      return normalizeBranch(result.json).commitSha;
    },

    async pathExists(
      token: string,
      owner: string,
      repo: string,
      ref: string,
      path: string
    ): Promise<boolean> {
      try {
        // Bodyless request: existence is determined entirely by whether
        // the request succeeds — the Contents API's response (which can
        // include base64 file content for small files) is never read.
        await githubRequestNoBody(
          token,
          `${repoBasePath(owner, repo)}/contents/${encodePathSegments(path)}`,
          { ref },
          logger
        );

        return true;
      } catch (error) {
        if (error instanceof SourceClientError && error.kind === "not-found") {
          return false;
        }

        throw error;
      }
    }
  };
}
