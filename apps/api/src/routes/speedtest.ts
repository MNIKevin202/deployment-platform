import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import {
  clearSpeedtestConnection,
  getSpeedtestConnectionInfo,
  runSpeedtest,
  saveSpeedtestConnection,
  type SpeedtestDeps,
  type SpeedtestProvider
} from "../services/speedtest-service.js";

interface RegisterSpeedtestRoutesOptions {
  appDatabase: AppDatabase;
  /** Shared, cached provider — see createSpeedtestProvider. */
  provider: SpeedtestProvider;
  /** Built per request so a settings change takes effect without a restart. */
  buildDeps: () => SpeedtestDeps;
}

const connectionSchema = z.object({
  url: z.string().min(1).max(2000),
  token: z.string().min(1).max(500)
});

export async function registerSpeedtestRoutes(
  fastify: FastifyInstance,
  { appDatabase, provider, buildDeps }: RegisterSpeedtestRoutesOptions
): Promise<void> {
  // Connection status only — never the token itself.
  fastify.get(
    "/settings/speedtest",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async () => {
      return { success: true, ...getSpeedtestConnectionInfo(appDatabase) };
    }
  );

  fastify.put(
    "/settings/speedtest",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = connectionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ success: false, message: "A Speedtest Tracker URL and API token are both required." });
      }

      const result = await saveSpeedtestConnection(buildDeps(), parsed.data);

      if (!result.success) {
        return reply.code(result.statusCode ?? 400).send({ success: false, message: result.message });
      }

      // The stored connection changed, so any cached reading is stale.
      provider.invalidate();

      return { success: true, ...result.info };
    }
  );

  fastify.delete(
    "/settings/speedtest",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async () => {
      clearSpeedtestConnection(appDatabase);
      provider.invalidate();
      return { success: true, ...getSpeedtestConnectionInfo(appDatabase) };
    }
  );

  /**
   * Queues a test on the connected instance. The result isn't available
   * immediately — Speedtest Tracker runs it in the background — so the
   * cached reading is dropped and the panel picks up the new value on its
   * next poll.
   */
  fastify.post(
    "/speedtest/run",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      const result = await runSpeedtest(buildDeps());

      if (!result.success) {
        return reply.code(result.statusCode ?? 400).send({ success: false, message: result.message });
      }

      provider.invalidate();
      return { success: true, message: result.message };
    }
  );

  /**
   * The latest reading, from the shared cache. Never fails the request when
   * the remote instance is unreachable — the panel shows the reason instead,
   * exactly as it does for a Docker-usage lookup that times out.
   */
  fastify.get(
    "/speedtest/latest",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async () => {
      const info = getSpeedtestConnectionInfo(appDatabase);
      if (!info.configured) {
        return { success: true, configured: false, reading: null, error: null };
      }

      const { reading, error } = await provider.getLatest();
      return { success: true, configured: true, reading, error };
    }
  );
}
