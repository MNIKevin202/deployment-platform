import type { FastifyInstance } from "fastify";
import type Docker from "dockerode";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { getContainerMetrics } from "../services/docker-metrics-service.js";
import { resolveManagedContainer } from "../services/managed-container-resolver.js";

interface RegisterMetricsRoutesOptions {
  appDatabase: AppDatabase;
  docker: Docker;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

export async function registerMetricsRoutes(
  fastify: FastifyInstance,
  { appDatabase, docker }: RegisterMetricsRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/metrics",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      let resolved;

      try {
        resolved = await resolveManagedContainer(appDatabase, docker, parsedParams.data.id);
      } catch (error) {
        request.log.error(error, "Unable to inspect container for metrics");

        return reply.code(502).send({
          success: false,
          message: "Unable to reach Docker to load metrics"
        });
      }

      if (!resolved.found) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      if (!resolved.containerExists || !resolved.running || !resolved.containerId) {
        return {
          success: true,
          containerRunning: false,
          metrics: null
        };
      }

      const result = await getContainerMetrics(docker, resolved.containerId);

      if (!result.success) {
        if (result.reason === "not-found") {
          return {
            success: true,
            containerRunning: false,
            metrics: null
          };
        }

        request.log.error({ appId: resolved.app.id, error: result.message }, "Unable to load container metrics");

        return reply.code(502).send({
          success: false,
          message: "Unable to load container metrics"
        });
      }

      return {
        success: true,
        containerRunning: true,
        metrics: result.metrics
      };
    }
  );
}
