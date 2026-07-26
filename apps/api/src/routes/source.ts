import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase, StoredAppSource } from "../database.js";
import { appSourceConfigSchema } from "../schemas/source.js";
import {
  removeAppSource,
  saveAppSource,
  revalidateAppSource,
  type AppSourceServiceDeps
} from "../services/app-source-service.js";

interface RegisterSourceRoutesOptions {
  appDatabase: AppDatabase;
  sourceServiceDeps: AppSourceServiceDeps;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

function serializeSource(source: StoredAppSource) {
  return {
    appId: source.appId,
    provider: source.provider,
    repositoryOwner: source.repositoryOwner,
    repositoryName: source.repositoryName,
    repositoryId: source.repositoryId,
    repositoryVisibility: source.repositoryVisibility,
    branch: source.branch,
    deploymentMode: source.deploymentMode,
    dockerfilePath: source.dockerfilePath,
    buildContext: source.buildContext,
    autoDeploy: source.autoDeploy,
    lastValidatedCommitSha: source.lastValidatedCommitSha,
    lastValidatedAt: source.lastValidatedAt,
    validationStatus: source.validationStatus,
    validationError: source.validationError,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };
}

export async function registerSourceRoutes(
  fastify: FastifyInstance,
  { appDatabase, sourceServiceDeps }: RegisterSourceRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/source",
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

      const source = appDatabase.getAppSource(app.id);

      return {
        success: true,
        source: source ? serializeSource(source) : null
      };
    }
  );

  fastify.put<{ Params: AppIdParams }>(
    "/apps/:id/source",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const parsedBody = appSourceConfigSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid source configuration",
          errors: parsedBody.error.flatten()
        });
      }

      const result = await saveAppSource(sourceServiceDeps, parsedParams.data.id, parsedBody.data);

      if (!result.success) {
        return reply.code(result.statusCode ?? 502).send({ success: false, message: result.message });
      }

      return reply.code(200).send({
        success: true,
        source: result.source ? serializeSource(result.source) : null
      });
    }
  );

  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/source/validate",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const result = await revalidateAppSource(sourceServiceDeps, parsedParams.data.id);

      if (!result.success) {
        return reply.code(result.statusCode ?? 502).send({ success: false, message: result.message });
      }

      return {
        success: true,
        source: result.source ? serializeSource(result.source) : null
      };
    }
  );

  fastify.delete<{ Params: AppIdParams }>(
    "/apps/:id/source",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const result = removeAppSource(sourceServiceDeps, parsedParams.data.id);

      if (!result.success) {
        return reply.code(result.statusCode ?? 502).send({ success: false, message: result.message });
      }

      return { success: true };
    }
  );
}
