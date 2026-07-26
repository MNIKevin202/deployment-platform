import type { AppDatabase } from "../database.js";
import { decryptSecret, encryptSecret, loadEncryptionKey } from "./crypto-service.js";
import { SourceClientError, type SourceAccount, type SourceProviderClient } from "./source-provider.js";

const PROVIDER = "github" as const;

export type CredentialStatus =
  | "not-configured"
  | "connected"
  | "encryption-key-missing"
  | "encryption-key-invalid"
  | "credential-unavailable";

export interface GithubConnectionInfo {
  connected: boolean;
  provider: "github";
  username: string | null;
  lastValidatedAt: string | null;
  credentialStatus: CredentialStatus;
  /** Best-effort permission summary — null when not safely available. */
  permissions: string[] | null;
  /** True when the operator needs to fix server configuration (the
   * encryption key), not just re-enter a token. */
  setupRequired: boolean;
}

export interface GithubCredentialLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

type CredentialDatabase = Pick<
  AppDatabase,
  "getProviderCredential" | "upsertProviderCredential" | "deleteProviderCredential"
>;

export interface GithubCredentialDeps {
  appDatabase: CredentialDatabase;
  githubClient: SourceProviderClient;
  logger: GithubCredentialLogger;
  now?: () => Date;
}

function describeKeyUnavailable(reason: "missing" | "invalid-encoding" | "invalid-length"): string {
  switch (reason) {
    case "missing":
      return "GitHub integration requires the server to be configured with CREDENTIAL_ENCRYPTION_KEY before a token can be saved.";
    case "invalid-encoding":
      return "CREDENTIAL_ENCRYPTION_KEY is not valid base64 — GitHub integration is unavailable until it's fixed.";
    case "invalid-length":
    default:
      return "CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes — GitHub integration is unavailable until it's fixed.";
  }
}

function credentialStatusForKeyReason(
  reason: "missing" | "invalid-encoding" | "invalid-length"
): CredentialStatus {
  return reason === "missing" ? "encryption-key-missing" : "encryption-key-invalid";
}

/** Maps a `SourceClientError` (or anything else) to an HTTP status the route should use. */
function statusCodeForClientError(error: unknown): number {
  if (!(error instanceof SourceClientError)) {
    return 502;
  }

  switch (error.kind) {
    case "invalid-token":
      return 401;
    case "insufficient-permissions":
      return 403;
    case "rate-limited":
      return 429;
    case "not-found":
      return 404;
    case "network-timeout":
      return 504;
    case "malformed-response":
    case "service-error":
    default:
      return 502;
  }
}

function safeMessage(error: unknown): string {
  // SourceClientError messages are already sanitized (see github-client.ts)
  // — never the raw provider response. Anything else is collapsed to a
  // generic message rather than surfacing an unknown error's detail.
  if (error instanceof SourceClientError) {
    return error.message;
  }

  return "Unable to reach GitHub right now.";
}

export interface TestGithubTokenResult {
  success: boolean;
  statusCode?: number;
  message?: string;
  account?: SourceAccount;
}

/**
 * Validates a token against the real GitHub API without persisting
 * anything. Used both by "Test Connection" and as the first step of
 * saving a new credential — there is exactly one place a token is ever
 * checked against GitHub.
 */
export async function testGithubToken(
  githubClient: SourceProviderClient,
  token: string
): Promise<TestGithubTokenResult> {
  try {
    const account = await githubClient.validateCredential(token);
    return { success: true, account };
  } catch (error) {
    return { success: false, statusCode: statusCodeForClientError(error), message: safeMessage(error) };
  }
}

export interface SaveGithubCredentialResult {
  success: boolean;
  statusCode?: number;
  message?: string;
  info?: GithubConnectionInfo;
}

/**
 * Validates the token against GitHub first, and only encrypts/stores it if
 * that succeeds — a credential is never persisted without having been
 * confirmed to work. Replaces any existing GitHub credential in place (one
 * row per provider).
 */
export async function saveGithubCredential(
  deps: GithubCredentialDeps,
  token: string
): Promise<SaveGithubCredentialResult> {
  const keyStatus = loadEncryptionKey();

  if (!keyStatus.available) {
    return { success: false, statusCode: 503, message: describeKeyUnavailable(keyStatus.reason) };
  }

  const validation = await testGithubToken(deps.githubClient, token);

  if (!validation.success || !validation.account) {
    return { success: false, statusCode: validation.statusCode, message: validation.message };
  }

  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const encryptedPayload = encryptSecret(keyStatus.key, token);

  deps.appDatabase.upsertProviderCredential({
    provider: PROVIDER,
    encryptedPayload,
    authenticatedUsername: validation.account.username,
    // GitHub does not reliably expose granted fine-grained permissions on
    // a plain /user call — left null rather than guessed.
    permissionsJson: null,
    lastValidatedAt: nowIso
  });

  deps.logger.info(
    { provider: PROVIDER, username: validation.account.username },
    "GitHub credential saved"
  );

  return { success: true, info: getGithubConnectionInfo({ appDatabase: deps.appDatabase }) };
}

/**
 * Safe, token-free connection summary — this is the only thing any GET
 * route ever returns for GitHub integration status.
 */
export function getGithubConnectionInfo(deps: { appDatabase: CredentialDatabase }): GithubConnectionInfo {
  const stored = deps.appDatabase.getProviderCredential(PROVIDER);

  if (!stored) {
    return {
      connected: false,
      provider: PROVIDER,
      username: null,
      lastValidatedAt: null,
      credentialStatus: "not-configured",
      permissions: null,
      setupRequired: false
    };
  }

  const keyStatus = loadEncryptionKey();

  if (!keyStatus.available) {
    return {
      connected: false,
      provider: PROVIDER,
      username: stored.authenticatedUsername,
      lastValidatedAt: stored.lastValidatedAt,
      credentialStatus: credentialStatusForKeyReason(keyStatus.reason),
      permissions: null,
      setupRequired: true
    };
  }

  try {
    decryptSecret(keyStatus.key, stored.encryptedPayload);
  } catch {
    // Wrong/rotated key or corrupted row — never surface the raw crypto
    // error, just report the credential as unavailable.
    return {
      connected: false,
      provider: PROVIDER,
      username: stored.authenticatedUsername,
      lastValidatedAt: stored.lastValidatedAt,
      credentialStatus: "credential-unavailable",
      permissions: null,
      setupRequired: false
    };
  }

  let permissions: string[] | null = null;

  if (stored.permissionsJson) {
    try {
      const parsed = JSON.parse(stored.permissionsJson);
      permissions = Array.isArray(parsed) ? parsed : null;
    } catch {
      permissions = null;
    }
  }

  return {
    connected: true,
    provider: PROVIDER,
    username: stored.authenticatedUsername,
    lastValidatedAt: stored.lastValidatedAt,
    credentialStatus: "connected",
    permissions,
    setupRequired: false
  };
}

export function deleteGithubCredential(deps: { appDatabase: CredentialDatabase; logger: GithubCredentialLogger }): void {
  deps.appDatabase.deleteProviderCredential(PROVIDER);
  deps.logger.info({ provider: PROVIDER }, "GitHub credential removed");
}

export type DecryptedTokenResult =
  | { success: true; token: string }
  | { success: false; credentialStatus: CredentialStatus };

/**
 * Internal use only — the decrypted token this returns must never be
 * placed in a route response, an event, or a log line. Only
 * app-source-service and the GitHub routes that proxy a single live
 * lookup (repositories/branches/commits) should ever call this.
 */
export function getDecryptedGithubToken(deps: { appDatabase: CredentialDatabase }): DecryptedTokenResult {
  const stored = deps.appDatabase.getProviderCredential(PROVIDER);

  if (!stored) {
    return { success: false, credentialStatus: "not-configured" };
  }

  const keyStatus = loadEncryptionKey();

  if (!keyStatus.available) {
    return { success: false, credentialStatus: credentialStatusForKeyReason(keyStatus.reason) };
  }

  try {
    const token = decryptSecret(keyStatus.key, stored.encryptedPayload);
    return { success: true, token };
  } catch {
    return { success: false, credentialStatus: "credential-unavailable" };
  }
}
