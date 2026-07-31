import type { FastifyInstance, FastifyReply } from "fastify";
import type Docker from "dockerode";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { resolveManagedContainer } from "../services/managed-container-resolver.js";
import {
  IRC_CONFIG_PATH,
  IRC_MOTD_PATH,
  hashOperatorPassword,
  isContainerRunning,
  isIrcServerImage,
  parseGeneralSettings,
  parseOperators,
  readFileFromContainer,
  rehashIrcServer,
  removeOperator,
  restoreConfigBackup,
  updateGeneralSettings,
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

const channelNameSchema = z
  .string()
  .regex(/^[#&][^\s,:]{1,49}$/, "Channel names must start with # or & and contain no spaces, commas, or colons");

// Ergo sends this raw as an IRC ISUPPORT NETWORK= token, whose value is a
// single space-delimited field in the protocol — any whitespace in it is
// invalid enough that Ergo refuses to load the whole config file, not just
// that one setting (confirmed live: this exact case took the server down in
// a boot loop until fixed by hand). Restricting to a conservative charset
// up front means the write is rejected before it's ever saved, rather than
// only discovered after the server fails to come back up.
const networkNameSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Za-z0-9_.-]+$/, "Network name can only contain letters, digits, '.', '_', and '-' (no spaces)");

// Ergo also sends this as a raw IRC mode string (e.g. "+ntC") — same
// single-token constraint applies.
const channelModesSchema = z
  .string()
  .max(50)
  .regex(/^[+-][A-Za-z]*$/, "Must be a mode string like +ntC, with no spaces");

const generalSettingsSchema = z.object({
  networkName: networkNameSchema.optional(),
  autoJoinChannels: z.array(channelNameSchema).max(20).optional(),
  defaultChannelModes: channelModesSchema.optional(),
  maxChannelsPerClient: z.number().int().min(1).max(10_000).optional(),
  channelRegistrationEnabled: z.boolean().optional(),
  channelRegistrationOperatorOnly: z.boolean().optional(),
  maxChannelsPerAccount: z.number().int().min(1).max(10_000).optional(),
  accountRegistrationEnabled: z.boolean().optional(),
  allowRegistrationBeforeConnect: z.boolean().optional(),
  emailVerificationEnabled: z.boolean().optional()
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

const HEALTH_CHECK_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WriteConfigResult {
  ok: boolean;
  /** Only meaningful when ok is false: whether the pre-write backup was restored. */
  restored: boolean;
}

/**
 * Writes a config file, rehashes, and then actually checks the server came
 * back up. Schema validation can catch known-bad shapes, but not every way a
 * value can be semantically invalid to Ergo — confirmed live, a network name
 * with a space passed validation, then took the whole server down in a boot
 * loop until someone noticed and fixed it by hand. This is the backstop: on
 * a failed health check it attempts to restore the pre-write backup and
 * rehash again, and reports honestly whether that restore worked, rather
 * than a route silently returning success into what's actually a crash loop.
 */
async function writeConfigSafely(
  docker: Docker,
  containerId: string,
  path: string,
  content: string
): Promise<WriteConfigResult> {
  await writeFileToContainer(docker, containerId, path, content);
  await rehashIrcServer(docker, containerId);
  await sleep(HEALTH_CHECK_DELAY_MS);

  if (await isContainerRunning(docker, containerId)) {
    return { ok: true, restored: false };
  }

  const restored = await restoreConfigBackup(docker, containerId, path);
  return { ok: false, restored };
}

function writeFailureMessage(restored: boolean): string {
  return restored
    ? "That change stopped the server from starting, so it was automatically reverted. Double-check the value and try again."
    : "That change stopped the server from starting, and the automatic revert couldn't reach the container. Check the Console tab and the app's own .bak config file.";
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

      const result = await writeConfigSafely(docker, containerId, IRC_CONFIG_PATH, updatedConfig);

      if (!result.ok) {
        return reply.code(502).send({ success: false, message: writeFailureMessage(result.restored) });
      }

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

      const result = await writeConfigSafely(docker, containerId, IRC_CONFIG_PATH, updatedConfig);

      if (!result.ok) {
        return reply.code(502).send({ success: false, message: writeFailureMessage(result.restored) });
      }

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
      const result = await writeConfigSafely(docker, containerId, IRC_MOTD_PATH, parsedBody.data.content);

      if (!result.ok) {
        return reply.code(502).send({ success: false, message: writeFailureMessage(result.restored) });
      }

      return { success: true };
    } catch (error) {
      request.log.error(error, "Unable to save IRC MOTD");
      return reply.code(502).send({ success: false, message: "Unable to save the MOTD" });
    }
  });

  fastify.get<{ Params: AppIdParams }>("/apps/:id/irc/settings", async (request, reply) => {
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

      if (configText === null) {
        return reply.code(502).send({ success: false, message: "The server's config file could not be found" });
      }

      return { success: true, settings: parseGeneralSettings(configText) };
    } catch (error) {
      request.log.error(error, "Unable to read IRC settings");
      return reply.code(502).send({ success: false, message: "Unable to read the server's config" });
    }
  });

  fastify.put<{ Params: AppIdParams }>("/apps/:id/irc/settings", async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const parsedBody = generalSettingsSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: parsedBody.error.issues[0]?.message ?? "Invalid settings"
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

      const updatedConfig = updateGeneralSettings(configText, parsedBody.data);

      const result = await writeConfigSafely(docker, containerId, IRC_CONFIG_PATH, updatedConfig);

      if (!result.ok) {
        return reply.code(502).send({ success: false, message: writeFailureMessage(result.restored) });
      }

      return { success: true, settings: parseGeneralSettings(updatedConfig) };
    } catch (error) {
      request.log.error(error, "Unable to save IRC settings");
      return reply.code(502).send({ success: false, message: "Unable to save the server's settings" });
    }
  });
}
