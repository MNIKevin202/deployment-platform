import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../database.js";

interface RegisterDeploymentSettingsRoutesOptions {
  appDatabase: AppDatabase;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

const autoDeployBodySchema = z.object({
  enabled: z.boolean()
});

interface AppIdParams {
  id: string;
}

export async function registerDeploymentSettingsRoutes(
  fastify: FastifyInstance,
  { appDatabase }: RegisterDeploymentSettingsRoutesOptions
): Promise<void> {
  // The most recent image-build output for an app (its Logs tab).
  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/build-log",
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

      const buildLog = appDatabase.getBuildLog(parsedParams.data.id);

      return {
        success: true,
        // null when the app has no linked source (e.g. a plain image app).
        buildLog
      };
    }
  );

  // Toggle whether new commits on the app's branch deploy automatically.
  fastify.patch<{ Params: AppIdParams }>(
    "/apps/:id/source/auto-deploy",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const parsedBody = autoDeployBodySchema.safeParse(request.body ?? {});

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

      const updated = appDatabase.setAutoDeploy(parsedParams.data.id, parsedBody.data.enabled);

      if (!updated) {
        return reply.code(409).send({
          success: false,
          message: "This app has no linked GitHub source, so auto-deploy can't be configured."
        });
      }

      return { success: true, autoDeploy: parsedBody.data.enabled };
    }
  );
}
