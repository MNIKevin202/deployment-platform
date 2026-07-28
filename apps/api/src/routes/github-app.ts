import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { readAuthenticatedUsername } from "../auth.js";
import type { AppDatabase } from "../database.js";
import type { GithubAppConfigResult } from "../services/github-app-config.js";
import { fetchInstallationInfo as defaultFetchInstallationInfo, type InstallationInfo } from "../services/github-app-service.js";
import type { GithubAppStateStore } from "../services/github-app-state-service.js";

export interface RegisterGithubAppRoutesOptions {
  appDatabase: Pick<
    AppDatabase,
    "listGithubAppInstallations" | "upsertGithubAppInstallation" | "deleteGithubAppInstallation"
  >;
  githubAppConfig: GithubAppConfigResult;
  stateStore: GithubAppStateStore;
  /**
   * GitHub App connect/disconnect is a global, account-level event — not
   * tied to any one managed app — so it is logged here rather than
   * recorded through RecordEventFn, whose app_deployment_events table has
   * a NOT NULL foreign key to a specific app.
   */
  logger: { info: (obj: unknown, message?: string) => void; error: (obj: unknown, message?: string) => void };
  /** The panel's own origin, for building error/success redirect targets. Defaults to the configured callback's origin. */
  panelOrigin?: string;
  /** Test seam — production always uses the real GitHub-calling implementation. */
  fetchInstallationInfo?: (config: GithubAppConfigResult & { configured: true }, installationId: number) => Promise<InstallationInfo>;
  /** Test seam — production always reads the real session cookie. */
  readSessionUsername?: (request: FastifyRequest) => string | null;
}

const callbackQuerySchema = z.object({
  installation_id: z.coerce.number().int().positive().optional(),
  setup_action: z.string().max(50).optional(),
  state: z.string().min(1).max(200).optional()
});

const disconnectBodySchema = z.object({
  installationId: z.coerce.number().int().positive()
});

function serializeInstallation(row: {
  installationId: number;
  accountLogin: string;
  accountType: string;
  targetType: string;
  repositorySelection: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    targetType: row.targetType,
    repositorySelection: row.repositorySelection,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function panelOriginFrom(config: GithubAppConfigResult, override?: string): string {
  if (override) return override;
  if (config.configured) {
    try {
      return new URL(config.callbackUrl).origin;
    } catch {
      // fall through
    }
  }
  return "";
}

export async function registerGithubAppRoutes(
  fastify: FastifyInstance,
  {
    appDatabase,
    githubAppConfig,
    stateStore,
    logger,
    panelOrigin,
    fetchInstallationInfo = defaultFetchInstallationInfo,
    readSessionUsername = readAuthenticatedUsername
  }: RegisterGithubAppRoutesOptions
): Promise<void> {
  const origin = panelOriginFrom(githubAppConfig, panelOrigin);

  function redirectTarget(params: Record<string, string>): string {
    const target = new URL("/", origin || "http://invalid.local");
    target.searchParams.set("section", "repositories");
    for (const [key, value] of Object.entries(params)) {
      target.searchParams.set(key, value);
    }
    return origin ? target.toString() : `/?${target.searchParams.toString()}`;
  }

  fastify.get(
    "/github/connect",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!githubAppConfig.configured) {
        return reply.code(503).send({
          success: false,
          message: "The GitHub App is not configured on this server.",
          missing: githubAppConfig.missing
        });
      }

      // Reachable only because the global auth hook already required a
      // valid session for this path (it is NOT in auth.ts's publicPaths) —
      // this call just identifies which operator it was, for the
      // installation's connected_by_username and the state's ownership tag.
      const username = readSessionUsername(request);
      if (!username) {
        return reply.code(401).send({ success: false, message: "Authentication required" });
      }

      const state = stateStore.create(username);

      const installUrl = new URL(`https://github.com/apps/${githubAppConfig.appSlug}/installations/new`);
      installUrl.searchParams.set("state", state);

      return reply.redirect(installUrl.toString(), 302);
    }
  );

  // Public path (see auth.ts) — GitHub's redirect back here is a top-level
  // cross-site navigation that never carries the session cookie. Security
  // is the one-time `state` value instead; see github-app-state-service.ts.
  fastify.get(
    "/github/callback",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedQuery = callbackQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        return reply.redirect(redirectTarget({ github: "error", message: "Malformed callback request." }), 302);
      }

      const { installation_id: installationId, setup_action: setupAction, state } = parsedQuery.data;

      if (!state) {
        return reply.redirect(redirectTarget({ github: "error", message: "Missing authorization state." }), 302);
      }

      // Consumed here, unconditionally — a replay of this exact callback
      // URL (the same state value used twice) fails from this point on,
      // whether or not the first attempt succeeded.
      const username = stateStore.consume(state);

      if (!username) {
        logger.error({ setupAction }, "GitHub App callback rejected: invalid, expired, or already-used state");
        return reply.redirect(
          redirectTarget({ github: "error", message: "Authorization request expired or was already used. Try Connect GitHub again." }),
          302
        );
      }

      if (!githubAppConfig.configured) {
        return reply.redirect(redirectTarget({ github: "error", message: "The GitHub App is not configured on this server." }), 302);
      }

      if (setupAction === "request") {
        // An organization member requested installation; an org owner must
        // approve it on GitHub's side before any installation exists yet.
        return reply.redirect(
          redirectTarget({ github: "pending", message: "Installation was requested and is awaiting approval from an organization owner." }),
          302
        );
      }

      if (!installationId) {
        return reply.redirect(redirectTarget({ github: "error", message: "GitHub did not return an installation." }), 302);
      }

      try {
        const info = await fetchInstallationInfo(githubAppConfig, installationId);

        // Ownership verification: the installation must belong to OUR
        // configured app, confirmed through GitHub's own API (using our
        // app's JWT — only the real app owner can even make this call
        // successfully) rather than trusted from the redirect's query
        // string alone.
        if (String(info.appId) !== githubAppConfig.appId) {
          logger.error(
            { installationId, expectedAppId: githubAppConfig.appId, returnedAppId: info.appId },
            "GitHub App callback rejected: installation does not belong to the configured app"
          );
          return reply.redirect(
            redirectTarget({ github: "error", message: "This installation does not belong to the configured GitHub App." }),
            302
          );
        }

        appDatabase.upsertGithubAppInstallation({
          installationId: info.installationId,
          appId: info.appId,
          accountLogin: info.accountLogin,
          accountId: info.accountId,
          accountType: info.accountType,
          targetType: info.targetType,
          repositorySelection: info.repositorySelection,
          connectedByUsername: username
        });

        logger.info(
          { installationId: info.installationId, accountLogin: info.accountLogin, repositorySelection: info.repositorySelection },
          "GitHub App installation connected"
        );

        return reply.redirect(redirectTarget({ github: "connected", installation: String(info.installationId) }), 302);
      } catch (error) {
        logger.error(
          { installationId, errorName: error instanceof Error ? error.name : "unknown" },
          "GitHub App callback failed while verifying the installation"
        );
        return reply.redirect(redirectTarget({ github: "error", message: "Unable to verify the GitHub App installation." }), 302);
      }
    }
  );

  fastify.get(
    "/github/installations",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async () => {
      return {
        success: true,
        configured: githubAppConfig.configured,
        ...(githubAppConfig.configured ? {} : { missing: githubAppConfig.missing }),
        installations: appDatabase.listGithubAppInstallations().map(serializeInstallation)
      };
    }
  );

  fastify.post(
    "/github/disconnect",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedBody = disconnectBodySchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({ success: false, message: "A valid installationId is required" });
      }

      // Removes only this platform's local record of the installation —
      // it never calls GitHub to uninstall the app. Uninstalling (or
      // changing repository access) is only ever done by the operator on
      // GitHub's own installation-settings page ("Manage access on
      // GitHub" in the UI), never automatically as a side effect of this
      // button.
      appDatabase.deleteGithubAppInstallation(parsedBody.data.installationId);

      logger.info(
        { installationId: parsedBody.data.installationId },
        "GitHub App installation disconnected (local metadata only)"
      );

      return { success: true };
    }
  );
}
