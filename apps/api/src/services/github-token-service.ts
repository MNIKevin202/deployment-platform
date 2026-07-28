import type { AppDatabase } from "../database.js";
import { getDecryptedGithubToken, type CredentialStatus } from "./github-credential-service.js";
import { mintInstallationToken } from "./github-app-service.js";
import type { GithubAppConfigResult } from "./github-app-config.js";

export type GithubTokenSource = "installation" | "pat";

export type ResolvedGithubToken =
  | { success: true; token: string; source: GithubTokenSource }
  | { success: false; credentialStatus: CredentialStatus };

export interface ResolveGithubTokenDeps {
  appDatabase: Pick<
    AppDatabase,
    "listGithubAppInstallations" | "getProviderCredential" | "upsertProviderCredential" | "deleteProviderCredential"
  >;
  githubAppConfig: GithubAppConfigResult;
  logger?: { error: (obj: unknown, message?: string) => void };
}

/**
 * The single place every GitHub-reading route/service asks for a usable
 * token — GitHub App installation-first, manual PAT as a fallback. This is
 * what makes the App the primary path without removing the advanced PAT
 * option: nothing downstream (repository listing, cloning, inspection)
 * needs to know which one it got, since both are plain bearer tokens.
 *
 * A fresh installation token is minted on every call — never cached,
 * never persisted. If minting fails (network issue, a revoked
 * installation, an expired/rotated app key) this falls through to the PAT
 * rather than failing outright, so a transient GitHub App problem doesn't
 * break deployment for an operator who also has a working PAT configured.
 * The failure is logged (without the JWT or any token) so it's visible in
 * server logs, never surfaced to the caller as anything but "use PAT" or
 * ultimately "not connected".
 */
export async function resolveGithubToken(deps: ResolveGithubTokenDeps): Promise<ResolvedGithubToken> {
  if (deps.githubAppConfig.configured) {
    const installations = deps.appDatabase.listGithubAppInstallations();
    const installation = installations[0];

    if (installation) {
      try {
        const minted = await mintInstallationToken(deps.githubAppConfig, installation.installationId);
        return { success: true, token: minted.token, source: "installation" };
      } catch (error) {
        deps.logger?.error(
          { installationId: installation.installationId, errorName: error instanceof Error ? error.name : "unknown" },
          "Unable to mint a GitHub App installation token; falling back to the manual PAT if configured"
        );
      }
    }
  }

  const pat = getDecryptedGithubToken({ appDatabase: deps.appDatabase });

  if (pat.success) {
    return { success: true, token: pat.token, source: "pat" };
  }

  return { success: false, credentialStatus: pat.credentialStatus };
}
