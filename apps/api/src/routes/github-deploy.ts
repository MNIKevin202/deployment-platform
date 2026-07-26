import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { githubDeployRequestSchema } from "../schemas/source.js";
import { deployFromGithub, type GithubDeployDependencies } from "../services/github-deploy-service.js";

interface RegisterGithubDeployRoutesOptions {
  appDatabase: AppDatabase;
  deployDeps: GithubDeployDependencies;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

export async function registerGithubDeployRoutes(
  fastify: FastifyInstance,
  { appDatabase, deployDeps }: RegisterGithubDeployRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/deploy/github/status",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      return {
        success: true,
        inProgress: appDatabase.isDeploymentLocked(parsedParams.data.id)
      };
    }
  );

  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/deploy/github",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const parsedBody = githubDeployRequestSchema.safeParse(request.body ?? {});

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid request",
          errors: parsedBody.error.flatten()
        });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      const result = await deployFromGithub(deployDeps, parsedParams.data.id, {
        expectedCommitSha: parsedBody.data.expectedCommitSha
      });

      if (!result.success) {
        // Rolled-back deployments are reported as a server-side failure
        // (502) since the platform's own build/deploy pipeline is what
        // failed; everything else (not-configured, already-in-progress,
        // pre-swap failures) is a 409 — the request itself was fine, the
        // current state just doesn't allow it right now.
        return reply.code(result.rolledBack ? 502 : 409).send({
          success: false,
          message: result.message,
          stage: result.stage,
          rolledBack: result.rolledBack
        });
      }

      return {
        success: true,
        message: result.message,
        containerId: result.containerId,
        imageTag: result.imageTag,
        commitSha: result.commitSha
      };
    }
  );
}
