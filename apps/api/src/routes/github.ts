import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { githubTokenSchema } from "../schemas/github.js";
import {
  repositoryNameSchema,
  repositoryOwnerSchema,
  branchNameSchema,
  subdirectorySchema,
  DEFAULT_SUBDIRECTORY
} from "../schemas/source.js";
import {
  deleteGithubCredential,
  getDecryptedGithubToken,
  getGithubConnectionInfo,
  saveGithubCredential,
  testGithubToken,
  type GithubCredentialDeps
} from "../services/github-credential-service.js";
import { SourceClientError, type SourceProviderClient } from "../services/source-provider.js";
import { inspectRepositoryRemote } from "../services/repository-inspection-service.js";
import { serializeInspection } from "./source.js";

interface RegisterGithubRoutesOptions {
  credentialDeps: GithubCredentialDeps;
  githubClient: SourceProviderClient;
}

const ownerRepoParamsSchema = z.object({
  owner: repositoryOwnerSchema,
  repo: repositoryNameSchema
});

interface OwnerRepoParams {
  owner: string;
  repo: string;
}

// No "search" field — GitHub's /user/repos listing has no
// repository-name search parameter. Name filtering happens client-side
// over whatever page(s) have already been loaded (see RepositoriesPage.tsx
// / SourcePanel.tsx), so the query contract here only ever describes
// pagination that GitHub actually honors.
const repositoriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100).optional().default(1),
  perPage: z.coerce.number().int().min(1).max(50).optional().default(20)
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100).optional().default(1),
  perPage: z.coerce.number().int().min(1).max(50).optional().default(20)
});

const commitsQuerySchema = listQuerySchema.extend({
  branch: branchNameSchema
});

// Used by the "Inspect Repository" step of both the Repository Source
// wizard and the Create App wizard, before any app/source row exists to
// attach the result to — this is a read-only preview, and it never
// persists anything. Deliberately just {branch, subdirectory}: owner/repo
// are already path params on this route, unlike the standalone
// repositoryInspectionRequestSchema which also carries them.
const inspectBodySchema = z
  .object({
    branch: branchNameSchema,
    subdirectory: subdirectorySchema.optional().default(DEFAULT_SUBDIRECTORY)
  })
  .strict();

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
    default:
      return 502;
  }
}

function safeMessage(error: unknown): string {
  return error instanceof SourceClientError ? error.message : "Unable to reach GitHub right now.";
}

export async function registerGithubRoutes(
  fastify: FastifyInstance,
  { credentialDeps, githubClient }: RegisterGithubRoutesOptions
): Promise<void> {
  fastify.get(
    "/integrations/github",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async () => {
      return { success: true, ...getGithubConnectionInfo({ appDatabase: credentialDeps.appDatabase }) };
    }
  );

  fastify.post(
    "/integrations/github/test",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedBody = githubTokenSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({ success: false, message: "A GitHub token is required" });
      }

      const result = await testGithubToken(githubClient, parsedBody.data.token);

      if (!result.success || !result.account) {
        return reply.code(result.statusCode ?? 502).send({ success: false, message: result.message });
      }

      return { success: true, account: result.account };
    }
  );

  fastify.put(
    "/integrations/github",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedBody = githubTokenSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({ success: false, message: "A GitHub token is required" });
      }

      const result = await saveGithubCredential(credentialDeps, parsedBody.data.token);

      if (!result.success || !result.info) {
        return reply.code(result.statusCode ?? 502).send({ success: false, message: result.message });
      }

      return { success: true, ...result.info };
    }
  );

  fastify.delete(
    "/integrations/github",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async () => {
      deleteGithubCredential(credentialDeps);
      return { success: true };
    }
  );

  fastify.get(
    "/integrations/github/repositories",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedQuery = repositoriesQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        return reply.code(400).send({ success: false, message: "Invalid query" });
      }

      const credential = getDecryptedGithubToken({ appDatabase: credentialDeps.appDatabase });

      if (!credential.success) {
        return reply.code(409).send({
          success: false,
          message: "GitHub is not connected.",
          credentialStatus: credential.credentialStatus
        });
      }

      try {
        const page = await githubClient.listRepositories(credential.token, {
          page: parsedQuery.data.page,
          perPage: parsedQuery.data.perPage
        });

        return { success: true, repositories: page.items, hasMore: page.hasMore };
      } catch (error) {
        return reply.code(statusCodeForClientError(error)).send({ success: false, message: safeMessage(error) });
      }
    }
  );

  fastify.get<{ Params: OwnerRepoParams }>(
    "/integrations/github/repositories/:owner/:repo",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = ownerRepoParamsSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid repository" });
      }

      const credential = getDecryptedGithubToken({ appDatabase: credentialDeps.appDatabase });

      if (!credential.success) {
        return reply.code(409).send({
          success: false,
          message: "GitHub is not connected.",
          credentialStatus: credential.credentialStatus
        });
      }

      try {
        const repository = await githubClient.getRepository(
          credential.token,
          parsedParams.data.owner,
          parsedParams.data.repo
        );

        return { success: true, repository };
      } catch (error) {
        return reply.code(statusCodeForClientError(error)).send({ success: false, message: safeMessage(error) });
      }
    }
  );

  fastify.get<{ Params: OwnerRepoParams }>(
    "/integrations/github/repositories/:owner/:repo/branches",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = ownerRepoParamsSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid repository" });
      }

      const parsedQuery = listQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        return reply.code(400).send({ success: false, message: "Invalid query" });
      }

      const credential = getDecryptedGithubToken({ appDatabase: credentialDeps.appDatabase });

      if (!credential.success) {
        return reply.code(409).send({
          success: false,
          message: "GitHub is not connected.",
          credentialStatus: credential.credentialStatus
        });
      }

      try {
        const page = await githubClient.listBranches(
          credential.token,
          parsedParams.data.owner,
          parsedParams.data.repo,
          { page: parsedQuery.data.page, perPage: parsedQuery.data.perPage }
        );

        return { success: true, branches: page.items, hasMore: page.hasMore };
      } catch (error) {
        return reply.code(statusCodeForClientError(error)).send({ success: false, message: safeMessage(error) });
      }
    }
  );

  fastify.get<{ Params: OwnerRepoParams }>(
    "/integrations/github/repositories/:owner/:repo/commits",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = ownerRepoParamsSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid repository" });
      }

      const parsedQuery = commitsQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        return reply.code(400).send({
          success: false,
          message: "A valid branch is required",
          errors: parsedQuery.error.flatten()
        });
      }

      const credential = getDecryptedGithubToken({ appDatabase: credentialDeps.appDatabase });

      if (!credential.success) {
        return reply.code(409).send({
          success: false,
          message: "GitHub is not connected.",
          credentialStatus: credential.credentialStatus
        });
      }

      try {
        const page = await githubClient.listCommits(
          credential.token,
          parsedParams.data.owner,
          parsedParams.data.repo,
          parsedQuery.data.branch,
          { page: parsedQuery.data.page, perPage: parsedQuery.data.perPage }
        );

        return { success: true, commits: page.items, hasMore: page.hasMore };
      } catch (error) {
        return reply.code(statusCodeForClientError(error)).send({ success: false, message: safeMessage(error) });
      }
    }
  );

  // Read-only repository inspection with no app/source dependency — used
  // by wizard "Inspect Repository" steps to preview the detected project
  // type and recommended build strategy for a candidate repository/
  // branch/subdirectory before anything is saved. Never writes to any
  // app row; the per-app POST /apps/:id/source/inspect route (which does
  // persist detection results against an already-saved source) is
  // unchanged and unrelated to this one.
  fastify.post<{ Params: OwnerRepoParams }>(
    "/integrations/github/repositories/:owner/:repo/inspect",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = ownerRepoParamsSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid repository" });
      }

      const parsedBody = inspectBodySchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "A valid branch is required",
          errors: parsedBody.error.flatten()
        });
      }

      const credential = getDecryptedGithubToken({ appDatabase: credentialDeps.appDatabase });

      if (!credential.success) {
        return reply.code(409).send({
          success: false,
          message: "GitHub is not connected.",
          credentialStatus: credential.credentialStatus
        });
      }

      try {
        const commitSha = await githubClient.resolveBranchCommit(
          credential.token,
          parsedParams.data.owner,
          parsedParams.data.repo,
          parsedBody.data.branch
        );

        const detection = await inspectRepositoryRemote(githubClient, {
          token: credential.token,
          repositoryOwner: parsedParams.data.owner,
          repositoryName: parsedParams.data.repo,
          ref: commitSha,
          subdirectory: parsedBody.data.subdirectory
        });

        return {
          success: true,
          commitSha,
          inspection: serializeInspection(detection)
        };
      } catch (error) {
        return reply.code(statusCodeForClientError(error)).send({ success: false, message: safeMessage(error) });
      }
    }
  );
}
