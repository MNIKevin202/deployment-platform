import type { FastifyInstance, FastifyReply } from "fastify";
import type Docker from "dockerode";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { resolveManagedContainer } from "../services/managed-container-resolver.js";
import {
  BotAdminUnreachableError,
  getBotConfig,
  getBotStatus,
  isIrcBotImage,
  registerBotNick,
  updateBotConfig
} from "../services/irc-bot-admin-service.js";

interface RegisterIrcBotAdminRoutesOptions {
  appDatabase: AppDatabase;
  docker: Docker;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

interface AppIdParams {
  id: string;
}

const configPatchSchema = z
  .object({
    welcomeMessageTemplate: z.string().max(1000).optional(),
    commandPrefix: z.string().min(1).max(10).optional(),
    rulesText: z.string().max(5000).optional(),
    botCommands: z.record(z.string(), z.string().max(1000)).optional(),
    bannedWords: z.array(z.string().max(200)).max(500).optional(),
    moderationAction: z.enum(["warn", "kick"]).optional()
  })
  .strict();

const registerNickSchema = z.object({
  password: z.string().min(1).max(300),
  email: z.string().email().max(300).optional()
});

interface BotTarget {
  containerName: string;
  containerPort: number;
}

/**
 * Resolves an app id to its container's DNS name + admin port, the same way
 * irc-admin.ts's resolveIrcChannelTarget does for the IRC server itself —
 * except here we're reaching the bot's own HTTP admin API, not opening a raw
 * IRC connection.
 */
async function resolveBotTarget(
  appDatabase: AppDatabase,
  docker: Docker,
  appId: number,
  reply: FastifyReply
): Promise<BotTarget | null> {
  const resolved = await resolveManagedContainer(appDatabase, docker, appId);

  if (!resolved.found) {
    reply.code(404).send({ success: false, message: "App not found" });
    return null;
  }

  if (!isIrcBotImage(resolved.app.image)) {
    reply.code(400).send({ success: false, message: "This app is not Quipora Bot" });
    return null;
  }

  if (!resolved.containerExists || !resolved.running || !resolved.app.containerName) {
    reply.code(409).send({ success: false, message: "The bot's container is not running" });
    return null;
  }

  return { containerName: resolved.app.containerName, containerPort: resolved.app.containerPort };
}

export async function registerIrcBotAdminRoutes(
  fastify: FastifyInstance,
  { appDatabase, docker }: RegisterIrcBotAdminRoutesOptions
): Promise<void> {
  fastify.get<{ Params: AppIdParams }>("/apps/:id/bot/status", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const target = await resolveBotTarget(appDatabase, docker, parsedParams.data.id, reply);
    if (!target) {
      return;
    }

    try {
      const status = await getBotStatus(target.containerName, target.containerPort);
      return { success: true, status };
    } catch (error) {
      request.log.error(error, "Unable to reach the bot's admin API");
      return reply.code(502).send({
        success: false,
        message: error instanceof BotAdminUnreachableError ? error.message : "Unable to reach the bot"
      });
    }
  });

  fastify.get<{ Params: AppIdParams }>("/apps/:id/bot/config", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const target = await resolveBotTarget(appDatabase, docker, parsedParams.data.id, reply);
    if (!target) {
      return;
    }

    try {
      const config = await getBotConfig(target.containerName, target.containerPort);
      return { success: true, config };
    } catch (error) {
      request.log.error(error, "Unable to reach the bot's admin API");
      return reply.code(502).send({
        success: false,
        message: error instanceof BotAdminUnreachableError ? error.message : "Unable to reach the bot"
      });
    }
  });

  fastify.put<{ Params: AppIdParams }>("/apps/:id/bot/config", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const parsedBody = configPatchSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: parsedBody.error.issues[0]?.message ?? "Invalid config"
      });
    }

    const target = await resolveBotTarget(appDatabase, docker, parsedParams.data.id, reply);
    if (!target) {
      return;
    }

    try {
      const result = await updateBotConfig(target.containerName, target.containerPort, parsedBody.data);
      if (!result.ok) {
        return reply.code(result.status).send({ success: false, message: result.message });
      }
      return { success: true, config: result.config };
    } catch (error) {
      request.log.error(error, "Unable to reach the bot's admin API");
      return reply.code(502).send({
        success: false,
        message: error instanceof BotAdminUnreachableError ? error.message : "Unable to reach the bot"
      });
    }
  });

  fastify.post<{ Params: AppIdParams }>("/apps/:id/bot/register-nick", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const parsedBody = registerNickSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: parsedBody.error.issues[0]?.message ?? "Invalid request"
      });
    }

    const target = await resolveBotTarget(appDatabase, docker, parsedParams.data.id, reply);
    if (!target) {
      return;
    }

    try {
      const { status, result } = await registerBotNick(
        target.containerName,
        target.containerPort,
        parsedBody.data.password,
        parsedBody.data.email
      );
      return reply.code(status).send(result);
    } catch (error) {
      request.log.error(error, "Unable to reach the bot's admin API");
      return reply.code(502).send({
        ok: false,
        message: error instanceof BotAdminUnreachableError ? error.message : "Unable to reach the bot"
      });
    }
  });
}
