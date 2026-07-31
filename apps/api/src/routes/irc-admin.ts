import type { FastifyInstance, FastifyReply } from "fastify";
import type Docker from "dockerode";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { resolveManagedContainer } from "../services/managed-container-resolver.js";
import {
  IRC_CONFIG_PATH,
  IRC_MOTD_PATH,
  hashOperatorPassword,
  isIrcServerImage,
  parseOperators,
  readFileFromContainer,
  rehashIrcServer,
  removeOperator,
  upsertOperator,
  writeFileToContainer
} from "../services/irc-admin-service.js";

interface RegisterIrcAdminRoutesOptions {
  appDatabase: AppDatabase;
  docker: Docker;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

const operatorParamSchema = idParamSchema.extend({
  username: z.string().min(1)
});

// IRC nick charset, loosely: letters/digits plus a handful of punctuation,
// must not start with a digit.
const operatorUsernameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z_][A-Za-z0-9_\-[\]{}^`|]*$/, "Not a valid IRC operator username");

const createOperatorSchema = z.object({
  username: operatorUsernameSchema,
  password: z.string().min(8).max(300),
  role: z.enum(["admin", "moderator"])
});

const motdSchema = z.object({
  content: z.string().max(50_000)
});

interface AppIdParams {
  id: string;
}

interface OperatorParams extends AppIdParams {
  username: string;
}

/**
 * Resolves the app, confirms it's an Ergo-based app with a running
 * container, and returns its container id — the shared precondition every
 * route below needs before touching the container's filesystem.
 */
async function resolveIrcContainer(
  appDatabase: AppDatabase,
  docker: Docker,
  appId: number,
  reply: FastifyReply
): Promise<string | null> {
  const resolved = await resolveManagedContainer(appDatabase, docker, appId);

  if (!resolved.found) {
    reply.code(404).send({ success: false, message: "App not found" });
    return null;
  }

  if (!isIrcServerImage(resolved.app.image)) {
    reply.code(400).send({ success: false, message: "This app is not an IRC server" });
    return null;
  }

  if (!resolved.containerExists || !resolved.running || !resolved.containerId) {
    reply
      .code(409)
      .send({ success: false, message: "The container is not running, so its settings can't be changed" });
    return null;
  }

  return resolved.containerId;
}

export async function registerIrcAdminRoutes(
  fastify: FastifyInstance,
  { appDatabase, docker }: RegisterIrcAdminRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams }>("/apps/:id/irc/operators", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const containerId = await resolveIrcContainer(appDatabase, docker, parsedParams.data.id, reply);
    if (!containerId) {
      return;
    }

    try {
      const configText = await readFileFromContainer(docker, containerId, IRC_CONFIG_PATH);
      const operators = configText ? parseOperators(configText) : [];

      return { success: true, operators };
    } catch (error) {
      request.log.error(error, "Unable to read IRC operator config");
      return reply.code(502).send({ success: false, message: "Unable to read the server's config" });
    }
  });

  fastify.post<{ Params: AppIdParams }>("/apps/:id/irc/operators", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const parsedBody = createOperatorSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: parsedBody.error.issues[0]?.message ?? "Invalid operator details"
      });
    }

    const containerId = await resolveIrcContainer(appDatabase, docker, parsedParams.data.id, reply);
    if (!containerId) {
      return;
    }

    try {
      const configText = await readFileFromContainer(docker, containerId, IRC_CONFIG_PATH);

      if (configText === null) {
        return reply.code(502).send({ success: false, message: "The server's config file could not be found" });
      }

      const passwordHash = await hashOperatorPassword(parsedBody.data.password);
      const updatedConfig = upsertOperator(configText, {
        username: parsedBody.data.username,
        passwordHash,
        role: parsedBody.data.role
      });

      await writeFileToContainer(docker, containerId, IRC_CONFIG_PATH, updatedConfig);
      await rehashIrcServer(docker, containerId);

      return { success: true, operators: parseOperators(updatedConfig) };
    } catch (error) {
      request.log.error(error, "Unable to add IRC operator");
      return reply.code(502).send({ success: false, message: "Unable to save the new operator" });
    }
  });

  fastify.delete<{ Params: OperatorParams }>("/apps/:id/irc/operators/:username", async (request, reply) => {
    const parsedParams = operatorParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid request" });
    }

    const containerId = await resolveIrcContainer(appDatabase, docker, parsedParams.data.id, reply);
    if (!containerId) {
      return;
    }

    try {
      const configText = await readFileFromContainer(docker, containerId, IRC_CONFIG_PATH);

      if (configText === null) {
        return reply.code(502).send({ success: false, message: "The server's config file could not be found" });
      }

      const updatedConfig = removeOperator(configText, parsedParams.data.username);

      await writeFileToContainer(docker, containerId, IRC_CONFIG_PATH, updatedConfig);
      await rehashIrcServer(docker, containerId);

      return { success: true, operators: parseOperators(updatedConfig) };
    } catch (error) {
      request.log.error(error, "Unable to remove IRC operator");
      return reply.code(502).send({ success: false, message: "Unable to remove the operator" });
    }
  });

  fastify.get<{ Params: AppIdParams }>("/apps/:id/irc/motd", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const containerId = await resolveIrcContainer(appDatabase, docker, parsedParams.data.id, reply);
    if (!containerId) {
      return;
    }

    try {
      const content = await readFileFromContainer(docker, containerId, IRC_MOTD_PATH);
      return { success: true, content: content ?? "" };
    } catch (error) {
      request.log.error(error, "Unable to read IRC MOTD");
      return reply.code(502).send({ success: false, message: "Unable to read the MOTD" });
    }
  });

  fastify.put<{ Params: AppIdParams }>("/apps/:id/irc/motd", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const parsedBody = motdSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: "Invalid MOTD content" });
    }

    const containerId = await resolveIrcContainer(appDatabase, docker, parsedParams.data.id, reply);
    if (!containerId) {
      return;
    }

    try {
      await writeFileToContainer(docker, containerId, IRC_MOTD_PATH, parsedBody.data.content);
      await rehashIrcServer(docker, containerId);

      return { success: true };
    } catch (error) {
      request.log.error(error, "Unable to save IRC MOTD");
      return reply.code(502).send({ success: false, message: "Unable to save the MOTD" });
    }
  });
}
