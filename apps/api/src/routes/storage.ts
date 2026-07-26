import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase, StoredAppVolume } from "../database.js";
import {
  createVolumeSchema,
  updateVolumeSchema
} from "../schemas/storage.js";
import {
  buildDefaultVolumeName,
  isReservedVolumeName
} from "../services/storage-service.js";

interface RegisterStorageRoutesOptions {
  appDatabase: AppDatabase;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

const nestedIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  volumeId: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

interface AppVolumeParams {
  id: string;
  volumeId: string;
}

function serializeVolume(volume: StoredAppVolume) {
  return {
    id: volume.id,
    appId: volume.appId,
    volumeName: volume.volumeName,
    containerPath: volume.containerPath,
    readOnly: volume.readOnly,
    createdAt: volume.createdAt,
    updatedAt: volume.updatedAt
  };
}

const MAX_NAME_GENERATION_ATTEMPTS = 25;

/**
 * Deterministic base name, with a numeric suffix appended only if that
 * exact name is already taken by another app's volume (volume names are
 * globally unique in Docker).
 */
function resolveVolumeName(
  appDatabase: AppDatabase,
  appName: string,
  containerPath: string
): string {
  const base = buildDefaultVolumeName(appName, containerPath);

  if (!appDatabase.getAppVolumeByName(base)) {
    return base;
  }

  for (let attempt = 2; attempt <= MAX_NAME_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = `${base}-${attempt}`;

    if (!appDatabase.getAppVolumeByName(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to generate a unique volume name");
}

export async function registerStorageRoutes(
  fastify: FastifyInstance,
  { appDatabase }: RegisterStorageRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/storage",
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid app id"
        });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({
          success: false,
          message: "App not found"
        });
      }

      return {
        volumes: appDatabase.listAppVolumes(app.id).map(serializeVolume)
      };
    }
  );

  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/storage",
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid app id"
        });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({
          success: false,
          message: "App not found"
        });
      }

      const parsedBody = createVolumeSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid storage configuration",
          errors: parsedBody.error.flatten()
        });
      }

      const { containerPath, readOnly } = parsedBody.data;

      if (appDatabase.getAppVolumeByPath(app.id, containerPath)) {
        return reply.code(409).send({
          success: false,
          message: `This app already has a storage mount at "${containerPath}"`
        });
      }

      let volumeName = parsedBody.data.volumeName;

      if (volumeName) {
        if (isReservedVolumeName(volumeName)) {
          return reply.code(400).send({
            success: false,
            message: `Volume name "${volumeName}" is reserved for platform use`
          });
        }

        if (appDatabase.getAppVolumeByName(volumeName)) {
          return reply.code(409).send({
            success: false,
            message: `Volume name "${volumeName}" is already in use`
          });
        }
      } else {
        try {
          volumeName = resolveVolumeName(appDatabase, app.name, containerPath);
        } catch {
          return reply.code(500).send({
            success: false,
            message: "Unable to generate a unique volume name"
          });
        }
      }

      const created = appDatabase.createAppVolume({
        appId: app.id,
        volumeName,
        containerPath,
        readOnly
      });

      appDatabase.touchAppEnvironment(app.id);

      return reply.code(201).send({
        success: true,
        volume: serializeVolume(created)
      });
    }
  );

  fastify.put<{ Params: AppVolumeParams }>(
    "/apps/:id/storage/:volumeId",
    async (request, reply) => {
      const parsedParams = nestedIdParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid app or volume id"
        });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({
          success: false,
          message: "App not found"
        });
      }

      const existing = appDatabase.getAppVolumeById(
        parsedParams.data.volumeId
      );

      if (!existing || existing.appId !== app.id) {
        return reply.code(404).send({
          success: false,
          message: "Storage mount not found"
        });
      }

      const parsedBody = updateVolumeSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid storage configuration",
          errors: parsedBody.error.flatten()
        });
      }

      if (
        parsedBody.data.containerPath &&
        parsedBody.data.containerPath !== existing.containerPath &&
        appDatabase.getAppVolumeByPath(app.id, parsedBody.data.containerPath)
      ) {
        return reply.code(409).send({
          success: false,
          message: `This app already has a storage mount at "${parsedBody.data.containerPath}"`
        });
      }

      appDatabase.updateAppVolume(existing.id, parsedBody.data);
      appDatabase.touchAppEnvironment(app.id);

      const updated = appDatabase.getAppVolumeById(existing.id);

      return {
        success: true,
        volume: updated ? serializeVolume(updated) : null
      };
    }
  );

  fastify.delete<{ Params: AppVolumeParams }>(
    "/apps/:id/storage/:volumeId",
    async (request, reply) => {
      const parsedParams = nestedIdParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid app or volume id"
        });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({
          success: false,
          message: "App not found"
        });
      }

      const existing = appDatabase.getAppVolumeById(
        parsedParams.data.volumeId
      );

      if (!existing || existing.appId !== app.id) {
        return reply.code(404).send({
          success: false,
          message: "Storage mount not found"
        });
      }

      // Removes only the platform's tracking record. The underlying Docker
      // named volume (and its data) is deliberately left in place — this
      // feature never deletes volumes automatically.
      appDatabase.deleteAppVolume(existing.id);
      appDatabase.touchAppEnvironment(app.id);

      return { success: true };
    }
  );
}
