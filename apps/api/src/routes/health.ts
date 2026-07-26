import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase, StoredAppHealthCheck } from "../database.js";
import { healthCheckConfigSchema, HEALTH_CHECK_DEFAULTS } from "../schemas/health.js";
import type { HealthCheckScheduler } from "../services/health-check-service.js";

interface RegisterHealthRoutesOptions {
  appDatabase: AppDatabase;
  scheduler: HealthCheckScheduler;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

function serializeHealthCheck(appId: number, config: StoredAppHealthCheck | null) {
  if (!config) {
    return {
      appId,
      configured: false,
      ...HEALTH_CHECK_DEFAULTS,
      state: "disabled" as const,
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastStatusCode: null,
      lastLatencyMs: null,
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      lastError: null
    };
  }

  return {
    appId,
    configured: true,
    enabled: config.enabled,
    path: config.path,
    expectedStatus: config.expectedStatus,
    intervalSeconds: config.intervalSeconds,
    timeoutSeconds: config.timeoutSeconds,
    failureThreshold: config.failureThreshold,
    successThreshold: config.successThreshold,
    state: config.state,
    lastCheckedAt: config.lastCheckedAt,
    lastSuccessAt: config.lastSuccessAt,
    lastFailureAt: config.lastFailureAt,
    lastStatusCode: config.lastStatusCode,
    lastLatencyMs: config.lastLatencyMs,
    consecutiveSuccesses: config.consecutiveSuccesses,
    consecutiveFailures: config.consecutiveFailures,
    lastError: config.lastError
  };
}

export async function registerHealthRoutes(
  fastify: FastifyInstance,
  { appDatabase, scheduler }: RegisterHealthRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/health",
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

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      return {
        success: true,
        health: serializeHealthCheck(app.id, appDatabase.getAppHealthCheck(app.id))
      };
    }
  );

  fastify.put<{ Params: AppIdParams }>(
    "/apps/:id/health",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      const parsedBody = healthCheckConfigSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid health check configuration",
          errors: parsedBody.error.flatten()
        });
      }

      const saved = appDatabase.upsertHealthConfig(app.id, parsedBody.data);

      return {
        success: true,
        health: serializeHealthCheck(app.id, saved)
      };
    }
  );

  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/health/check",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      const existingConfig = appDatabase.getAppHealthCheck(app.id);

      if (!existingConfig) {
        return reply.code(409).send({
          success: false,
          message: "Configure a health check for this app before running one manually"
        });
      }

      try {
        const outcome = await scheduler.runCheckNow(app.id);

        return {
          success: true,
          outcome,
          health: serializeHealthCheck(app.id, appDatabase.getAppHealthCheck(app.id))
        };
      } catch (error) {
        return reply.code(409).send({
          success: false,
          message: error instanceof Error ? error.message : "Unable to run health check"
        });
      }
    }
  );
}
