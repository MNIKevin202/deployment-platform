import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import {
  previewImagePrune,
  pruneImages,
  type ImagePruneDockerOps
} from "../services/image-prune-service.js";

interface RegisterImageRoutesOptions {
  appDatabase: AppDatabase;
  imageOps: ImagePruneDockerOps;
}

const KEEP_SETTING = "image_prune_keep_per_app";
const DEFAULT_KEEP = 5;
const MAX_KEEP = 50;

const keepBodySchema = z.object({
  keepPerApp: z.coerce.number().int().min(0).max(MAX_KEEP)
});

function readKeepPerApp(appDatabase: AppDatabase): number {
  const raw = appDatabase.getSetting(KEEP_SETTING);
  if (raw === null) {
    return DEFAULT_KEEP;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_KEEP;
  }
  return Math.min(MAX_KEEP, Math.floor(parsed));
}

export async function registerImageRoutes(
  fastify: FastifyInstance,
  { appDatabase, imageOps }: RegisterImageRoutesOptions
): Promise<void> {
  // Current keep setting + a preview of what a prune would remove.
  fastify.get(
    "/images/prune",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      const keepPerApp = readKeepPerApp(appDatabase);
      try {
        const preview = await previewImagePrune(imageOps, keepPerApp);
        return { success: true, keepPerApp, ...preview };
      } catch {
        return reply.code(502).send({ success: false, message: "Unable to reach Docker to inspect images." });
      }
    }
  );

  // Update how many recent build images to keep per app.
  fastify.patch(
    "/images/prune",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = keepBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ success: false, message: `keepPerApp must be between 0 and ${MAX_KEEP}.` });
      }
      appDatabase.setSetting(KEEP_SETTING, String(parsed.data.keepPerApp));
      return { success: true, keepPerApp: parsed.data.keepPerApp };
    }
  );

  // Remove the prunable images (dangling + old per-app builds beyond the keep count).
  fastify.post(
    "/images/prune/run",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      const keepPerApp = readKeepPerApp(appDatabase);
      try {
        const result = await pruneImages(imageOps, keepPerApp);
        return { success: true, ...result };
      } catch {
        return reply.code(502).send({ success: false, message: "Unable to reach Docker to prune images." });
      }
    }
  );
}
