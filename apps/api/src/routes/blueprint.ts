import type { FastifyInstance, FastifyReply } from "fastify";
import type Docker from "dockerode";
import { z } from "zod";
import type { AppDatabase } from "../database.js";
import { resolveManagedContainer } from "../services/managed-container-resolver.js";
import {
  deleteOllamaModel,
  findLinkedOllamaApp,
  getOllamaVersion,
  getPullState,
  isBlueprintWebImage,
  isValidOllamaModelName,
  listOllamaModels,
  OllamaUnreachableError,
  startOllamaPull,
  type OllamaModel
} from "../services/ollama-service.js";

interface RegisterBlueprintRoutesOptions {
  appDatabase: AppDatabase;
  docker: Docker;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

/**
 * The model name is validated twice on purpose: the schema rejects the
 * obviously wrong shapes at the edge, and isValidOllamaModelName is applied
 * again inside the service so no future caller can bypass it.
 */
const modelBodySchema = z.object({
  model: z
    .string()
    .min(1)
    .max(128)
    .refine(isValidOllamaModelName, "Not a valid Ollama model name")
});

interface ResolvedOllamaTarget {
  containerName: string;
  containerPort: number;
  running: boolean;
}

/**
 * Resolves the private model server behind a Blueprint app, replying with a
 * clear, actionable error when it can't be found or isn't running. Mirrors
 * irc-admin.ts's resolveLinkedBotTarget.
 */
async function resolveOllamaTarget(
  appDatabase: AppDatabase,
  docker: Docker,
  blueprintAppId: number,
  reply: FastifyReply
): Promise<ResolvedOllamaTarget | null> {
  const candidates = appDatabase.listApps().map((app) => ({
    id: app.id,
    image: app.image,
    containerName: app.containerName,
    containerId: app.containerId
  }));

  const linked = findLinkedOllamaApp(
    candidates,
    (appId) =>
      appDatabase
        .listAppEnvVars(appId)
        .map((envVar) => ({ key: envVar.key, value: envVar.value })),
    blueprintAppId
  );

  if (!linked || !linked.containerName) {
    reply.code(409).send({
      success: false,
      message:
        "No model server is linked to this app. Blueprint's OLLAMA_BASE_URL must point at a model-server app on this platform."
    });
    return null;
  }

  const lookup = await resolveManagedContainer(appDatabase, docker, linked.id);

  return {
    containerName: linked.containerName,
    containerPort: lookup.found ? lookup.app.containerPort : 11434,
    running: lookup.found ? lookup.running : false
  };
}

/**
 * Blueprint's model-management API. Every route is keyed by the Blueprint
 * app's own id — the model server is never addressed directly from the
 * browser, and its container name is resolved server-side from the app's
 * stored configuration.
 */
export function registerBlueprintRoutes(
  app: FastifyInstance,
  { appDatabase, docker }: RegisterBlueprintRoutesOptions
): void {
  /** Guards every route: the id must be a Blueprint (Open WebUI) app. */
  const requireBlueprintApp = (id: number, reply: FastifyReply) => {
    const storedApp = appDatabase.getAppById(id);

    if (!storedApp) {
      reply.code(404).send({ success: false, message: "App not found" });
      return null;
    }

    if (!isBlueprintWebImage(storedApp.image)) {
      reply.code(400).send({
        success: false,
        message: "This app is not a Blueprint app"
      });
      return null;
    }

    return storedApp;
  };

  app.get("/apps/:id/blueprint/status", async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const storedApp = requireBlueprintApp(params.data.id, reply);
    if (!storedApp) {
      return reply;
    }

    const webLookup = await resolveManagedContainer(appDatabase, docker, storedApp.id);
    const webRunning = webLookup.found ? webLookup.running : false;

    const target = await resolveOllamaTarget(appDatabase, docker, storedApp.id, reply);
    if (!target) {
      return reply;
    }

    let models: OllamaModel[] = [];
    let version: string | null = null;
    let modelServerReachable = false;
    let modelError: string | null = null;

    if (target.running) {
      try {
        version = await getOllamaVersion(target.containerName, target.containerPort);
        models = await listOllamaModels(target.containerName, target.containerPort);
        modelServerReachable = true;
      } catch (error) {
        modelError =
          error instanceof OllamaUnreachableError
            ? error.message
            : "Unable to read the installed model list.";
      }
    }

    return reply.send({
      success: true,
      status: {
        webRunning,
        webDomain: storedApp.domain,
        modelServerName: target.containerName,
        modelServerRunning: target.running,
        modelServerReachable,
        modelServerUrl: `http://${target.containerName}:${target.containerPort}`,
        version,
        models,
        // Total bytes the downloaded models occupy on the model server's
        // volume — the practical measure of Blueprint's disk footprint.
        modelStorageBytes: models.reduce((sum, model) => sum + model.size, 0),
        modelError,
        pull: getPullState(storedApp.id)
      }
    });
  });

  app.get("/apps/:id/blueprint/pull", async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ success: false, message: "Invalid app id" });
    }

    const storedApp = requireBlueprintApp(params.data.id, reply);
    if (!storedApp) {
      return reply;
    }

    return reply.send({ success: true, pull: getPullState(storedApp.id) });
  });

  app.post(
    "/apps/:id/blueprint/models",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const body = modelBodySchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({
          success: false,
          message:
            "Provide a valid Ollama model name, such as llama3.2:3b."
        });
      }

      const storedApp = requireBlueprintApp(params.data.id, reply);
      if (!storedApp) {
        return reply;
      }

      const target = await resolveOllamaTarget(appDatabase, docker, storedApp.id, reply);
      if (!target) {
        return reply;
      }

      if (!target.running) {
        return reply.code(409).send({
          success: false,
          message:
            "The model server is not running, so a model can't be downloaded right now."
        });
      }

      const result = startOllamaPull(
        storedApp.id,
        target.containerName,
        target.containerPort,
        body.data.model,
        (line) => app.log.info(line)
      );

      return reply.code(result.status).send({
        success: result.started,
        message: result.message,
        pull: result.state
      });
    }
  );

  app.delete(
    "/apps/:id/blueprint/models",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ success: false, message: "Invalid app id" });
      }

      const body = modelBodySchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({
          success: false,
          message: "Provide a valid Ollama model name."
        });
      }

      const storedApp = requireBlueprintApp(params.data.id, reply);
      if (!storedApp) {
        return reply;
      }

      const target = await resolveOllamaTarget(appDatabase, docker, storedApp.id, reply);
      if (!target) {
        return reply;
      }

      if (!target.running) {
        return reply.code(409).send({
          success: false,
          message: "The model server is not running, so a model can't be deleted right now."
        });
      }

      try {
        const result = await deleteOllamaModel(
          target.containerName,
          target.containerPort,
          body.data.model
        );

        return reply
          .code(result.ok ? 200 : result.status)
          .send({ success: result.ok, message: result.message });
      } catch (error) {
        return reply.code(502).send({
          success: false,
          message:
            error instanceof OllamaUnreachableError
              ? error.message
              : "Unable to reach the model server."
        });
      }
    }
  );
}
