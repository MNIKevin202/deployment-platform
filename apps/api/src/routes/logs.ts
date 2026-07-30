import type { FastifyInstance } from "fastify";
import type Docker from "dockerode";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { getAppLogs } from "../services/docker-logs-service.js";
import { streamAppLogs, type AppLogStreamHandle } from "../services/docker-log-stream-service.js";
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

const STREAM_MAX_TAIL = 1000;
const STREAM_DEFAULT_TAIL = 200;

const logStreamQuerySchema = z.object({
  tail: z.coerce.number().int().min(0).max(STREAM_MAX_TAIL).optional().default(STREAM_DEFAULT_TAIL),
  timestamps: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((value) => value === "true")
});

interface LogStreamQuerystring {
  tail?: string;
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

  // Live console: a Server-Sent Events stream that follows the container's
  // stdout/stderr in real time. Read-only — it resolves the container the
  // same safe way as the snapshot endpoint and never runs anything in it.
  fastify.get<{ Params: AppIdParams; Querystring: LogStreamQuerystring }>(
    "/apps/:id/logs/stream",
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

      const parsedQuery = logStreamQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid log stream query",
          errors: parsedQuery.error.flatten()
        });
      }

      let resolved;

      try {
        resolved = await resolveManagedContainer(appDatabase, docker, parsedParams.data.id);
      } catch (error) {
        request.log.error(error, "Unable to inspect container for log stream");

        return reply.code(502).send({
          success: false,
          message: "Unable to reach Docker to stream logs"
        });
      }

      if (!resolved.found) {
        return reply.code(404).send({ success: false, message: "App not found" });
      }

      // Take over the socket for a raw SSE response.
      reply.hijack();
      const raw = reply.raw;

      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Tell any intermediary proxy not to buffer this response.
        "X-Accel-Buffering": "no"
      });
      // Suggested client reconnect backoff for EventSource.
      raw.write("retry: 3000\n\n");

      function send(event: string, data: unknown): void {
        if (!raw.writableEnded) {
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      }

      // Comment-only heartbeat keeps idle proxy connections from timing out.
      const heartbeat = setInterval(() => {
        if (!raw.writableEnded) {
          raw.write(": ping\n\n");
        }
      }, 25000);

      let closed = false;
      let handle: AppLogStreamHandle | null = null;

      function cleanup(): void {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        handle?.close();
        if (!raw.writableEnded) {
          raw.end();
        }
      }

      // The client navigating away / closing the tab must release the
      // underlying Docker follow stream — otherwise it leaks per viewer.
      request.raw.on("close", cleanup);

      try {
        handle = await streamAppLogs(
          docker,
          resolved,
          { tail: parsedQuery.data.tail, timestamps: parsedQuery.data.timestamps },
          {
            onLine: (line) => send("line", { line }),
            onError: (message) => send("notice", { message }),
            onEnd: () => {
              send("end", {});
              cleanup();
            }
          }
        );

        // The client may have disconnected during the async setup above.
        if (closed) {
          handle.close();
        }
      } catch (error) {
        request.log.error(error, "Log stream failed to start");
        send("notice", { message: "Unable to start the log stream." });
        cleanup();
      }
    }
  );
}
