import { readFileSync } from "node:fs";

/**
 * GitHub App configuration, read from the environment once at startup.
 * Every field is optional at the type level because the platform must
 * start and serve everything else — including the manual PAT fallback —
 * whether or not a GitHub App has been registered yet. `loadGithubAppConfig()`
 * never throws; the API and UI both check `.configured` and report
 * "not configured" rather than crashing (see routes/github-app.ts and
 * RepositoriesPage.tsx).
 *
 * The private key may be supplied two ways:
 *   - GITHUB_APP_PRIVATE_KEY: the PEM contents directly (as one env value,
 *     literal "\n" sequences are unescaped — this is how most secret
 *     managers/compose env files carry a multi-line value).
 *   - GITHUB_APP_PRIVATE_KEY_PATH: a path to a mounted PEM file, read once
 *     at startup. Preferred for the VPS install (the key never touches an
 *     env var listing at all this way).
 * Exactly one is required; neither is ever logged.
 */
export interface GithubAppConfig {
  configured: true;
  appId: string;
  privateKeyPem: string;
  callbackUrl: string;
  /** e.g. "deployment-platform" — the part of https://github.com/apps/<slug>. */
  appSlug: string;
  clientId: string | null;
  clientSecret: string | null;
}

export interface GithubAppNotConfigured {
  configured: false;
  /** Which required setting(s) are missing — safe to show in the UI, never a value. */
  missing: string[];
}

export type GithubAppConfigResult = GithubAppConfig | GithubAppNotConfigured;

function readPrivateKey(env: NodeJS.ProcessEnv): { value: string | null; sourceMissing: boolean } {
  const path = env.GITHUB_APP_PRIVATE_KEY_PATH;

  if (path) {
    try {
      const content = readFileSync(path, "utf8").trim();
      return { value: content.length > 0 ? content : null, sourceMissing: content.length === 0 };
    } catch {
      // The path was configured but unreadable — treated as missing, not a
      // crash. The specific filesystem error is never exposed (it could
      // include the configured path).
      return { value: null, sourceMissing: true };
    }
  }

  const inline = env.GITHUB_APP_PRIVATE_KEY;

  if (!inline || inline.trim().length === 0) {
    return { value: null, sourceMissing: true };
  }

  // Most env-file/secret-manager conventions store a multi-line PEM as a
  // single value with literal backslash-n sequences instead of real
  // newlines — unescape them so createSign() gets a real PEM either way.
  return { value: inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline, sourceMissing: false };
}

/**
 * Loads and validates GitHub App configuration from the environment.
 * Called once at startup (server.ts) and safe to call again in tests.
 */
export function loadGithubAppConfig(env: NodeJS.ProcessEnv = process.env): GithubAppConfigResult {
  const missing: string[] = [];

  const appId = env.GITHUB_APP_ID?.trim();
  if (!appId) missing.push("GITHUB_APP_ID");

  const { value: privateKeyPem, sourceMissing } = readPrivateKey(env);
  if (sourceMissing) missing.push("GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH)");

  const callbackUrl = env.GITHUB_APP_CALLBACK_URL?.trim();
  if (!callbackUrl) missing.push("GITHUB_APP_CALLBACK_URL");

  const appSlug = env.GITHUB_APP_SLUG?.trim() || env.GITHUB_APP_INSTALL_URL?.trim();
  if (!appSlug) missing.push("GITHUB_APP_SLUG (or GITHUB_APP_INSTALL_URL)");

  if (missing.length > 0 || !appId || !privateKeyPem || !callbackUrl || !appSlug) {
    return { configured: false, missing };
  }

  let normalizedCallbackUrl: URL;
  try {
    normalizedCallbackUrl = new URL(callbackUrl);
  } catch {
    return { configured: false, missing: ["GITHUB_APP_CALLBACK_URL (not a valid URL)"] };
  }
  if (normalizedCallbackUrl.protocol !== "https:") {
    return { configured: false, missing: ["GITHUB_APP_CALLBACK_URL (must be https)"] };
  }

  // GITHUB_APP_SLUG accepts either a bare slug or a full install URL —
  // normalize either shape down to just the slug for building the install URL.
  const slugMatch = /^https:\/\/github\.com\/apps\/([^/]+)/.exec(appSlug);
  const normalizedSlug = slugMatch ? slugMatch[1]! : appSlug;

  return {
    configured: true,
    appId,
    privateKeyPem,
    callbackUrl: normalizedCallbackUrl.toString(),
    appSlug: normalizedSlug,
    clientId: env.GITHUB_APP_CLIENT_ID?.trim() || null,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET?.trim() || null
  };
}

/** A redacted, log-safe summary — never the key, never the client secret. */
export function describeGithubAppConfig(config: GithubAppConfigResult): Record<string, unknown> {
  if (!config.configured) {
    return { configured: false, missing: config.missing };
  }

  return {
    configured: true,
    appId: config.appId,
    appSlug: config.appSlug,
    callbackUrl: config.callbackUrl,
    clientIdSet: config.clientId !== null,
    clientSecretSet: config.clientSecret !== null
  };
}
