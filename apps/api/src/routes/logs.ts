import type { FastifyInstance } from "fastify";
import type Docker from "dockerode";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { getAppLogs } from "../services/docker-logs-service.js";
import { resolveManagedContainer } from "../services/managed-container-resolver.js";

interface RegisterLogsRoutesOptions {
  appDatabase: AppDatabase;
  docker: Docker;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

const MAX_TAIL = 2000;
const DEFAULT_TAIL = 200;
const MAX_SINCE_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

const logsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(MAX_TAIL).optional().default(DEFAULT_TAIL),
  since: z.coerce.number().int().min(0).optional(),
  // Query params arrive as strings — z.coerce.boolean() would treat the
  // string "false" as truthy, so this is validated explicitly instead.
  timestamps: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((value) => value === "true")
});

interface LogsQuerystring {
  tail?: string;
  since?: string;
  timestamps?: string;
}

export async function registerLogsRoutes(
  fastify: FastifyInstance,
  { appDatabase, docker }: RegisterLogsRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams; Querystring: LogsQuerystring }>(
    "/apps/:id/logs",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const parsedQuery = logsQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid log query",
          errors: parsedQuery.error.flatten()
        });
      }

      if (parsedQuery.data.since !== undefined) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const earliestAllowed = nowSeconds - MAX_SINCE_LOOKBACK_SECONDS;

        if (parsedQuery.data.since < earliestAllowed || parsedQuery.data.since > nowSeconds) {
          return reply.code(400).send({
            success: false,
            message: `"since" must be within the last ${MAX_SINCE_LOOKBACK_SECONDS / 86400} days`
          });
        }
      }

      let resolved;

      try {
        resolved = await resolveManagedContainer(appDatabase, docker, parsedParams.data.id);
      } catch (error) {
        request.log.error(error, "Unable to inspect container for logs");

        return reply.code(502).send({
          success: false,
          message: "Unable to reach Docker to load logs"
        });
      }

      if (!resolved.found) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      const result = await getAppLogs(docker, resolved, {
        tail: parsedQuery.data.tail,
        since: parsedQuery.data.since,
        timestamps: parsedQuery.data.timestamps
      });

      return { success: true, ...result };
    }
  );
}
