import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase, StoredDatabaseConnection } from "../database.js";
import {
  createConnectionSchema,
  updateConnectionSchema
} from "../schemas/connection.js";
import { redactConnectionString } from "../connection-redaction.js";
import { testConnection } from "../connection-test.js";

interface RegisterConnectionRoutesOptions {
  appDatabase: AppDatabase;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface IdParams {
  id: string;
}

/**
 * The stored connection string carries a password, so listings never include
 * it — only a redacted `preview`. The full value is handed back solely by the
 * dedicated `/reveal` endpoint, on an explicit copy action. `inGlobalEnv`
 * reports whether a global variable with this connection's key currently
 * exists, so the UI can show "already shared with every app".
 */
function maskConnection(
  connection: StoredDatabaseConnection,
  inGlobalEnv: boolean
) {
  return {
    id: connection.id,
    name: connection.name,
    kind: connection.kind,
    envKey: connection.envKey,
    preview: redactConnectionString(connection.connectionString),
    inGlobalEnv,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

export async function registerConnectionRoutes(
  fastify: FastifyInstance,
  { appDatabase }: RegisterConnectionRoutesOptions
): Promise<void> {
  function isKeyInGlobalEnv(envKey: string | null): boolean {
    return envKey !== null && appDatabase.getGlobalEnvVarByKey(envKey) !== null;
  }

  fastify.get("/connections", async () => {
    return {
      connections: appDatabase
        .listConnections()
        .map((connection) =>
          maskConnection(connection, isKeyInGlobalEnv(connection.envKey))
        )
    };
  });

  const testBodySchema = z.object({
    connectionString: z.string().min(1, "Connection string is required")
  });

  // Reachability probe for a connection string typed into the dialog (not yet
  // saved). Resolves the host and opens a TCP connection — see connection-test.
  fastify.post("/connections/test", async (request, reply) => {
    const parsed = testBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        message: "A connection string is required to test"
      });
    }

    const result = await testConnection(parsed.data.connectionString);
    return { success: true, ...result };
  });

  // Reachability probe for an already-saved connection, by id — used when
  // editing, where the dialog doesn't hold the stored string.
  fastify.post<{ Params: IdParams }>(
    "/connections/:id/test",
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply
          .code(400)
          .send({ success: false, message: "Invalid connection id" });
      }

      const existing = appDatabase.getConnectionById(parsedParams.data.id);

      if (!existing) {
        return reply
          .code(404)
          .send({ success: false, message: "Connection not found" });
      }

      const result = await testConnection(existing.connectionString);
      return { success: true, ...result };
    }
  );

  fastify.post("/connections", async (request, reply) => {
    const parsedBody = createConnectionSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: "Invalid connection",
        errors: parsedBody.error.flatten()
      });
    }

    const created = appDatabase.createConnection(parsedBody.data);

    return reply.code(201).send({
      success: true,
      connection: maskConnection(created, isKeyInGlobalEnv(created.envKey))
    });
  });

  fastify.put<{ Params: IdParams }>(
    "/connections/:id",
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply
          .code(400)
          .send({ success: false, message: "Invalid connection id" });
      }

      const existing = appDatabase.getConnectionById(parsedParams.data.id);

      if (!existing) {
        return reply
          .code(404)
          .send({ success: false, message: "Connection not found" });
      }

      const parsedBody = updateConnectionSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Invalid connection",
          errors: parsedBody.error.flatten()
        });
      }

      appDatabase.updateConnection(existing.id, parsedBody.data);
      const updated = appDatabase.getConnectionById(existing.id);

      return {
        success: true,
        connection: updated
          ? maskConnection(updated, isKeyInGlobalEnv(updated.envKey))
          : null
      };
    }
  );

  fastify.delete<{ Params: IdParams }>(
    "/connections/:id",
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply
          .code(400)
          .send({ success: false, message: "Invalid connection id" });
      }

      const existing = appDatabase.getConnectionById(parsedParams.data.id);

      if (!existing) {
        return reply
          .code(404)
          .send({ success: false, message: "Connection not found" });
      }

      appDatabase.deleteConnection(existing.id);

      return { success: true };
    }
  );

  // The one endpoint that returns the secret in the clear — reached only by an
  // explicit "copy" or "reveal" action in the UI, never by the list view.
  fastify.get<{ Params: IdParams }>(
    "/connections/:id/reveal",
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply
          .code(400)
          .send({ success: false, message: "Invalid connection id" });
      }

      const existing = appDatabase.getConnectionById(parsedParams.data.id);

      if (!existing) {
        return reply
          .code(404)
          .send({ success: false, message: "Connection not found" });
      }

      return {
        success: true,
        connectionString: existing.connectionString
      };
    }
  );

  // Push the connection into the global environment as a secret variable, so
  // every managed app inherits it. Idempotent: creates the variable if it is
  // missing, otherwise updates its value in place.
  fastify.post<{ Params: IdParams }>(
    "/connections/:id/push-to-global",
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);

      if (!parsedParams.success) {
        return reply
          .code(400)
          .send({ success: false, message: "Invalid connection id" });
      }

      const existing = appDatabase.getConnectionById(parsedParams.data.id);

      if (!existing) {
        return reply
          .code(404)
          .send({ success: false, message: "Connection not found" });
      }

      if (!existing.envKey) {
        return reply.code(400).send({
          success: false,
          message:
            "Set a variable name on this connection before adding it to the global environment"
        });
      }

      const current = appDatabase.getGlobalEnvVarByKey(existing.envKey);

      if (current) {
        appDatabase.updateGlobalEnvVar(current.id, {
          value: existing.connectionString,
          isSecret: true,
          enabled: true
        });
      } else {
        appDatabase.createGlobalEnvVar({
          key: existing.envKey,
          value: existing.connectionString,
          isSecret: true,
          enabled: true
        });
      }

      appDatabase.touchAllAppsEnvironment();

      return {
        success: true,
        key: existing.envKey,
        created: current === null
      };
    }
  );
}
