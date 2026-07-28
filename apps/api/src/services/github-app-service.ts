/**
 * The GitHub App-authenticated operations: minting short-lived installation
 * access tokens, reading installation metadata (for ownership verification
 * during the callback), and listing the repositories a specific
 * installation actually grants access to.
 *
 * Every call here authenticates as the app itself with a fresh JWT
 * (signGithubAppJwt — 9-minute lifetime, never reused across calls) or as
 * one specific installation with a token minted moments earlier. Nothing
 * this module returns or accepts is ever written to a log line, a
 * deployment event, or the database — installation tokens exist only in a
 * local variable for the duration of the call that needed one.
 */
import { clampPage, clampPerPage, githubRequestJson, hasNextPage, normalizeRepository } from "./github-client.js";
import { SourceClientError, type SourceClientPage, type SourceRepository } from "./source-provider.js";
import { signGithubAppJwt } from "./github-app-jwt.js";
import type { GithubAppConfig } from "./github-app-config.js";

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "DeploymentPlatform-GithubApp/1.0";
const DEFAULT_TIMEOUT_MS = 10_000;

async function githubAppFetch(
  jwtOrToken: string,
  path: string,
  init: { method?: string; timeoutMs?: number } = {}
): Promise<{ status: number; json: unknown; linkHeader: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${jwtOrToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SourceClientError("network-timeout", "GitHub request timed out");
    }
    throw new SourceClientError("service-error", "Unable to reach GitHub");
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new SourceClientError("malformed-response", "GitHub returned an unexpected response");
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new SourceClientError("invalid-token", "GitHub rejected the app/installation credential");
    }
    if (status === 404) {
      throw new SourceClientError("not-found", "GitHub installation was not found");
    }
    if (status === 429) {
      throw new SourceClientError("rate-limited", "GitHub API rate limit reached");
    }
    throw new SourceClientError("service-error", "GitHub App API request failed");
  }

  return { status: response.status, json, linkHeader: response.headers.get("link") };
}

export interface InstallationAccessToken {
  token: string;
  /** ISO timestamp — informational only; this value is never persisted. */
  expiresAt: string;
}

/**
 * Mints a fresh installation access token, valid for ~1 hour per GitHub's
 * own expiry (never extended, never cached here — a new one is minted
 * every time this is called). The caller must use it immediately and let
 * it go out of scope; nothing in this codebase writes it anywhere durable.
 */
export async function mintInstallationToken(
  config: GithubAppConfig,
  installationId: number
): Promise<InstallationAccessToken> {
  const jwt = signGithubAppJwt(config.appId, config.privateKeyPem);
  const result = await githubAppFetch(jwt, `/app/installations/${installationId}/access_tokens`, {
    method: "POST"
  });

  const obj = result.json as Record<string, unknown> | null;
  const token = obj && typeof obj.token === "string" ? obj.token : null;
  const expiresAt = obj && typeof obj.expires_at === "string" ? obj.expires_at : null;

  if (!token || !expiresAt) {
    throw new SourceClientError("malformed-response", "GitHub did not return an installation token");
  }

  return { token, expiresAt };
}

export interface InstallationInfo {
  installationId: number;
  appId: number;
  accountLogin: string;
  accountId: number;
  accountType: string;
  targetType: string;
  repositorySelection: string;
}

function normalizeInstallation(raw: unknown): InstallationInfo {
  if (!raw || typeof raw !== "object") {
    throw new SourceClientError("malformed-response", "GitHub response is missing the installation body");
  }
  const obj = raw as Record<string, unknown>;
  const account = obj.account as Record<string, unknown> | undefined;
  const appId = obj.app_id;
  const installationId = obj.id;

  if (typeof installationId !== "number" || typeof appId !== "number") {
    throw new SourceClientError("malformed-response", "GitHub installation response is missing required fields");
  }
  if (!account || typeof account.login !== "string" || typeof account.id !== "number") {
    throw new SourceClientError("malformed-response", "GitHub installation response is missing account details");
  }

  return {
    installationId,
    appId,
    accountLogin: account.login,
    accountId: account.id,
    // "User" or "Organization" — GitHub's own account.type field.
    accountType: typeof account.type === "string" ? account.type : "unknown",
    targetType: typeof obj.target_type === "string" ? obj.target_type : "unknown",
    repositorySelection: typeof obj.repository_selection === "string" ? obj.repository_selection : "selected"
  };
}

/**
 * Fetches installation metadata using the APP's own JWT (not an
 * installation token) — this is what makes ownership verification
 * meaningful: only the real app owner can even make this call, and the
 * returned `appId` is compared against our configured GITHUB_APP_ID by the
 * caller (routes/github-app.ts) before the installation is ever trusted.
 */
export async function fetchInstallationInfo(
  config: GithubAppConfig,
  installationId: number
): Promise<InstallationInfo> {
  const jwt = signGithubAppJwt(config.appId, config.privateKeyPem);
  const result = await githubAppFetch(jwt, `/app/installations/${installationId}`);
  return normalizeInstallation(result.json);
}

/**
 * Lists repositories reachable through a specific installation — the
 * `/installation/repositories` endpoint (authenticated with that
 * installation's own access token), which GitHub scopes to exactly the
 * repositories selected during installation. This is deliberately NOT
 * `/user/repos` (the PAT-flow endpoint, which lists the whole account) —
 * using it here would defeat the entire point of least-privilege
 * repository selection.
 */
export async function listInstallationRepositories(
  installationToken: string,
  options?: { page?: number; perPage?: number }
): Promise<SourceClientPage<SourceRepository>> {
  const result = await githubRequestJson(
    installationToken,
    "/installation/repositories",
    { per_page: clampPerPage(options?.perPage), page: clampPage(options?.page) },
    undefined
  );

  const obj = result.json as Record<string, unknown> | null;
  const list = obj && Array.isArray(obj.repositories) ? obj.repositories : null;

  if (!list) {
    throw new SourceClientError("malformed-response", "GitHub returned an unexpected installation repository list");
  }

  return { items: list.map(normalizeRepository), hasMore: hasNextPage(result.linkHeader) };
}
