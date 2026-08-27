import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AppDatabase,
  StoredAppEnvVar,
  StoredGlobalEnvVar
} from "../database.js";
import {
  bulkEnvVarsSchema,
  createEnvVarSchema,
  updateEnvVarSchema
} from "../schemas/environment.js";
import {
  buildEffectiveEnvironment,
  buildEnvironmentExport,
  computeEnvironmentStatus
} from "../services/environment-service.js";
import { verifyPassword } from "../auth.js";

interface RegisterEnvironmentRoutesOptions {
  appDatabase: AppDatabase;
  exportPasswordHash?: string;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

const nestedIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  variableId: z.coerce.number().int().positive()
});

const exportSchema = z.object({
  password: z.string().min(1).max(500)
});

interface AppIdParams {
  id: string;
}

interface AppVariableParams {
  id: string;
  variableId: string;
}

/**
 * `value` is only included when the variable isn't a secret — secrets are
 * write-only over the API from this point on: creation, listing, and
 * lookups never return the stored value, only whether one is set.
 */
function maskGlobalVar(variable: StoredGlobalEnvVar) {
  return {
    id: variable.id,
    key: variable.key,
    isSecret: variable.isSecret,
    enabled: variable.enabled,
    hasValue: variable.value.length > 0,
    value: variable.isSecret ? null : variable.value,
    createdAt: variable.createdAt,
    updatedAt: variable.updatedAt
  };
}

function maskAppVar(variable: StoredAppEnvVar) {
  return {
    id: variable.id,
    appId: variable.appId,
    key: variable.key,
    isSecret: variable.isSecret,
    enabled: variable.enabled,
    hasValue: variable.value.length > 0,
    value: variable.isSecret ? null : variable.value,
    createdAt: variable.createdAt,
    updatedAt: variable.updatedAt
  };
}

export async function registerEnvironmentRoutes(
  fastify: FastifyInstance,
  { appDatabase, exportPasswordHash }: RegisterEnvironmentRoutesOptions
): Promise<void> {
  const effectiveExportPasswordHash =
    exportPasswordHash ||
    process.env.ENVIRONMENT_EXPORT_PASSWORD_HASH ||
    process.env.ADMIN_PASSWORD_HASH ||
    "";

  function authorizeExport(requestBody: unknown): boolean {
    const parsed = exportSchema.safeParse(requestBody);
    return Boolean(
      parsed.success &&
      effectiveExportPasswordHash &&
      verifyPassword(parsed.data.password, effectiveExportPasswordHash)
    );
  }

  fastify.get("/environment/global", async () => {
    return {
      variables: appDatabase.listGlobalEnvVars().map(maskGlobalVar)
    };
  });

  fastify.post(
    "/environment/global/export",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
      }
    },
    async (request, reply) => {
      if (!authorizeExport(request.body)) {
        return reply.code(401).send({
          success: false,
          message: "Invalid environment export password"
        });
      }

      return {
        success: true,
        content: buildEnvironmentExport(appDatabase.listGlobalEnvVars())
      };
    }
  );

  fastify.post("/environment/global", async (request, reply) => {
    const parsedBody = createEnvVarSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: "Invalid environment variable",
        errors: parsedBody.error.flatten()
      });
    }

    const { key, value, isSecret, enabled } = parsedBody.data;

    if (appDatabase.getGlobalEnvVarByKey(key)) {
      return reply.code(409).send({
        success: false,
        message: `A global variable named "${key}" already exists`
      });
    }

    const created = appDatabase.createGlobalEnvVar({
      key,
      value,
      isSecret,
      enabled
    });

    appDatabase.touchAllAppsEnvironment();

    return reply.code(201).send({
      success: true,
      variable: maskGlobalVar(created)
    });
  });

  fastify.put<{ Params: AppIdParams }>(
    "/environment/global/:id",
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid variable id"
        });
      }

      const existing = appDatabase.getGlobalEnvVarById(parsedParams.data.id);

      if (!existing) {
        return reply.code(404).send({
          success: false,
          message: "Global variable not found"
        });
      }

      const parsedBody = updateEnvVarSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid environment variable",
          errors: parsedBody.error.flatten()
        });
      }

      appDatabase.updateGlobalEnvVar(existing.id, parsedBody.data);
      appDatabase.touchAllAppsEnvironment();

      const updated = appDatabase.getGlobalEnvVarById(existing.id);

      return {
        success: true,
        variable: updated ? maskGlobalVar(updated) : null
      };
    }
  );

  fastify.delete<{ Params: AppIdParams }>(
    "/environment/global/:id",
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid variable id"
        });
      }

      const existing = appDatabase.getGlobalEnvVarById(parsedParams.data.id);

      if (!existing) {
        return reply.code(404).send({
          success: false,
          message: "Global variable not found"
        });
      }

      appDatabase.deleteGlobalEnvVar(existing.id);
      appDatabase.touchAllAppsEnvironment();

      return { success: true };
    }
  );

  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/environment",
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
        variables: appDatabase.listAppEnvVars(app.id).map(maskAppVar)
      };
    }
  );

  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/environment/export",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
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

      if (!authorizeExport(request.body)) {
        return reply.code(401).send({
          success: false,
          message: "Invalid environment export password"
        });
      }

      return {
        success: true,
        content: buildEnvironmentExport(
          appDatabase.listGlobalEnvVars(),
          appDatabase.listAppEnvVars(app.id)
        )
      };
    }
  );

  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/environment",
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

      const parsedBody = createEnvVarSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid environment variable",
          errors: parsedBody.error.flatten()
        });
      }

      const { key, value, isSecret, enabled } = parsedBody.data;

      if (appDatabase.getAppEnvVarByKey(app.id, key)) {
        return reply.code(409).send({
          success: false,
          message: `A variable named "${key}" already exists for this app`
        });
      }

      const created = appDatabase.createAppEnvVar({
        appId: app.id,
        key,
        value,
        isSecret,
        enabled
      });

      appDatabase.touchAppEnvironment(app.id);

      return reply.code(201).send({
        success: true,
        variable: maskAppVar(created)
      });
    }
  );

  fastify.post<{ Params: AppIdParams }>(
    "/apps/:id/environment/bulk",
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

      const parsedBody = bulkEnvVarsSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid environment variables",
          errors: parsedBody.error.flatten()
        });
      }

      const { variables } = parsedBody.data;

      const seenKeys = new Set<string>();

      for (const variable of variables) {
        if (seenKeys.has(variable.key)) {
          return reply.code(400).send({
            success: false,
            message: `Duplicate key "${variable.key}" in submitted variables`
          });
        }

        seenKeys.add(variable.key);
      }

      let created = 0;
      let updated = 0;

      appDatabase.withTransaction(() => {
        for (const { key, value, isSecret } of variables) {
          const existing = appDatabase.getAppEnvVarByKey(app.id, key);

          if (existing) {
            // isSecret omitted means "leave the existing flag alone" —
            // updateAppEnvVar already treats an undefined isSecret that way.
            appDatabase.updateAppEnvVar(existing.id, { value, isSecret });
            updated += 1;
          } else {
            appDatabase.createAppEnvVar({
              appId: app.id,
              key,
              value,
              isSecret: isSecret ?? false,
              enabled: true
            });
            created += 1;
          }
        }
      });

      appDatabase.touchAppEnvironment(app.id);

      return reply.code(200).send({
        success: true,
        created,
        updated,
        variables: appDatabase.listAppEnvVars(app.id).map(maskAppVar)
      });
    }
  );

  fastify.put<{ Params: AppVariableParams }>(
    "/apps/:id/environment/:variableId",
    async (request, reply) => {
      const parsedParams = nestedIdParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid app or variable id"
        });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({
          success: false,
          message: "App not found"
        });
      }

      const existing = appDatabase.getAppEnvVarById(
        parsedParams.data.variableId
      );

      if (!existing || existing.appId !== app.id) {
        return reply.code(404).send({
          success: false,
          message: "Variable not found"
        });
      }

      const parsedBody = updateEnvVarSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid environment variable",
          errors: parsedBody.error.flatten()
        });
      }

      appDatabase.updateAppEnvVar(existing.id, parsedBody.data);
      appDatabase.touchAppEnvironment(app.id);

      const updated = appDatabase.getAppEnvVarById(existing.id);

      return {
        success: true,
        variable: updated ? maskAppVar(updated) : null
      };
    }
  );

  fastify.delete<{ Params: AppVariableParams }>(
    "/apps/:id/environment/:variableId",
    async (request, reply) => {
      const parsedParams = nestedIdParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid app or variable id"
        });
      }

      const app = appDatabase.getAppById(parsedParams.data.id);

      if (!app) {
        return reply.code(404).send({
          success: false,
          message: "App not found"
        });
      }

      const existing = appDatabase.getAppEnvVarById(
        parsedParams.data.variableId
      );

      if (!existing || existing.appId !== app.id) {
        return reply.code(404).send({
          success: false,
          message: "Variable not found"
        });
      }

      appDatabase.deleteAppEnvVar(existing.id);
      appDatabase.touchAppEnvironment(app.id);

      return { success: true };
    }
  );

  fastify.get<{ Params: AppIdParams }>(
    "/apps/:id/environment/effective",
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

      const globalVars = appDatabase.listGlobalEnvVars();
      const appVars = appDatabase.listAppEnvVars(app.id);

      return {
        variables: buildEffectiveEnvironment(globalVars, appVars),
        status: computeEnvironmentStatus(
          app.lastDeployedAt,
          app.environmentTouchedAt
        )
      };
    }
  );
}
