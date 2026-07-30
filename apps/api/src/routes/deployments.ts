import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase, StoredDeployment } from "../database.js";
import { revertToDeployment, type RevertDependencies } from "../services/revert-service.js";

interface RegisterDeploymentRoutesOptions {
  appDatabase: AppDatabase;
  revertDeps: RevertDependencies;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

const revertParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  version: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

interface RevertParams {
  id: string;
  version: string;
}

interface DeploymentsQuerystring {
  limit?: string;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

const deploymentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT)
});

function serializeDeployment(deployment: StoredDeployment) {
  return {
    id: deployment.id,
    appId: deployment.appId,
    version: deployment.version,
    imageTag: deployment.imageTag,
    commitSha: deployment.commitSha,
    commitMessage: deployment.commitMessage,
    sourceKind: deployment.sourceKind,
    revertOfVersion: deployment.revertOfVersion,
    isCurrent: deployment.isCurrent,
    // Only a retained GitHub build that isn't already live can be restored.
    canRevert: deployment.sourceKind === "github" && !deployment.isCurrent,
    createdAt: deployment.createdAt
  };
}

export async function registerDeploymentRoutes(
  fastify: FastifyInstance,
  { appDatabase, revertDeps }: RegisterDeploymentRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams; Querystring: DeploymentsQuerystring }>(
    "/apps/:id/deployments",
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

      const parsedQuery = deploymentsQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid query",
          errors: parsedQuery.error.flatten()
        });
      }

      const deployments = appDatabase.listDeployments(app.id, parsedQuery.data.limit);

      return {
        success: true,
        deployments: deployments.map(serializeDeployment)
      };
    }
  );

  fastify.post<{ Params: RevertParams }>(
    "/apps/:id/deployments/:version/revert",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = revertParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id or version" });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      const result = await revertToDeployment(revertDeps, parsedParams.data.id, parsedParams.data.version);

      if (!result.success) {
        // The request was well-formed; the current state (target missing,
        // not revertable, image pruned, or a failed-but-safe swap) just
        // doesn't allow it — a 409 mirrors the GitHub deploy route.
        return reply.code(409).send({ success: false, message: result.message });
      }

      return {
        success: true,
        message: result.message,
        newVersion: result.newVersion
      };
    }
  );
}
