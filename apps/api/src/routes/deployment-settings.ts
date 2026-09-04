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

const blockCommitBodySchema = z.object({
  // The commit to block (or, when blocked=false, the commit to clear).
  commitSha: z.string().min(7).max(64),
  blocked: z.boolean()
});

const retentionBodySchema = z.object({
  // null clears the per-app override, restoring the global default.
  retention: z.number().int().min(1).max(50).nullable()
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

  // Block (or unblock) auto-redeploying a specific failed commit. A newer
  // commit still auto-deploys, a manual deploy still works, and the block
  // clears itself once any deploy succeeds.
  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/source/block-commit",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const parsedBody = blockCommitBodySchema.safeParse(request.body ?? {});
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

      const updated = appDatabase.setAutoDeployBlockedCommit(
        parsedParams.data.id,
        parsedBody.data.blocked ? parsedBody.data.commitSha : null
      );

      if (!updated) {
        return reply.code(409).send({
          success: false,
          message: "This app has no linked GitHub source, so auto-deploy can't be configured."
        });
      }

      return { success: true, blocked: parsedBody.data.blocked };
    }
  );

  // Set (or clear, with null) how many rollback versions to keep for this app,
  // overriding the global default.
  fastify.patch<{ Params: AppIdParams }>(
    "/apps/:id/retention",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const parsedBody = retentionBodySchema.safeParse(request.body ?? {});

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Retention must be a whole number between 1 and 50, or null to use the global default.",
          errors: parsedBody.error.flatten()
        });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      appDatabase.updateAppRetention(parsedParams.data.id, parsedBody.data.retention);

      return { success: true, deploymentRetention: parsedBody.data.retention };
    }
  );
}
