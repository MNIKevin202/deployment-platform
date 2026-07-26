import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase, StoredDeploymentEvent } from "../database.js";

interface RegisterEventRoutesOptions {
  appDatabase: AppDatabase;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

interface EventsQuerystring {
  limit?: string;
  before?: string;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
  before: z.coerce.number().int().positive().optional()
});

function serializeEvent(event: StoredDeploymentEvent) {
  let metadata: Record<string, unknown> | null = null;

  if (event.metadataJson) {
    try {
      metadata = JSON.parse(event.metadataJson) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }

  return {
    id: event.id,
    appId: event.appId,
    eventType: event.eventType,
    severity: event.severity,
    message: event.message,
    metadata,
    createdAt: event.createdAt
  };
}

export async function registerEventRoutes(
  fastify: FastifyInstance,
  { appDatabase }: RegisterEventRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams; Querystring: EventsQuerystring }>(
    "/apps/:id/events",
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

      const parsedQuery = eventsQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid query",
          errors: parsedQuery.error.flatten()
        });
      }

      const events = appDatabase.listDeploymentEvents(app.id, {
        limit: parsedQuery.data.limit,
        beforeId: parsedQuery.data.before
      });

      return {
        success: true,
        events: events.map(serializeEvent),
        hasMore: events.length === parsedQuery.data.limit
      };
    }
  );
}
