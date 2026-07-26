import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { docker } from "./docker.js";
import { registerAuthentication } from "./auth.js";
import { createAppDatabase } from "./database.js";
import { buildAppDomain } from "./domain.js";
import { createRoutingService } from "./services/routing-service.js";

const appDatabase = createAppDatabase(
  process.env.DATABASE_PATH ?? "/data/deployment-platform.sqlite"
);

const routingService = createRoutingService({
  enabled: process.env.ROUTING_ENABLED === "true",
  docker,
  routesDirInApi: process.env.CADDY_ROUTES_DIR ?? "/caddy-routes",
  routesDirInCaddy: process.env.CADDY_ROUTES_DIR_IN_CADDY ?? "/etc/caddy",
  caddyContainerName:
    process.env.CADDY_CONTAINER_NAME ?? "deployment-platform-caddy",
  mainCaddyfilePathInCaddy:
    process.env.CADDY_MAIN_CONFIG_PATH ?? "/etc/caddy/Caddyfile",
  appsFilename: "apps.caddy"
});

const app = Fastify({
  logger: true
});

/**
 * Apps created before automatic domains existed (Phase 2) have a NULL
 * domain. Assign one deterministically on every boot so pre-existing apps
 * such as sqlite-test become routable without a manual repair step.
 */
function backfillMissingAppDomains(): void {
  const appsWithoutDomain = appDatabase
    .listApps()
    .filter((storedApp) => storedApp.domain === null);

  for (const storedApp of appsWithoutDomain) {
    const domain = buildAppDomain(storedApp.name);
    const conflictingApp = appDatabase.getAppByDomain(domain);

    if (conflictingApp && conflictingApp.id !== storedApp.id) {
      app.log.warn(
        { appId: storedApp.id, appName: storedApp.name, domain },
        "Skipped domain backfill: domain already assigned to a different app"
      );
      continue;
    }

    appDatabase.updateAppDomain(storedApp.id, domain);
  }
}

backfillMissingAppDomains();

await app.register(cors, {
  origin: true
});

await registerAuthentication(app);

interface ContainerParams {
  id: string;
}

const createAppSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(40)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Name must contain lowercase letters, numbers, and hyphens only"
    ),
  image: z.string().min(1).max(200),
  containerPort: z.number().int().min(1).max(65535)
});

const protectedContainerNames = new Set([
  "deployment-platform-api",
  "deployment-platform-web"
]);

function decodeDockerLogs(buffer: Buffer): string {
  const chunks: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const payloadLength = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + payloadLength;

    if (payloadEnd > buffer.length) {
      break;
    }

    chunks.push(
      buffer.subarray(payloadStart, payloadEnd).toString("utf8")
    );

    offset = payloadEnd;
  }

  if (chunks.length === 0) {
    return buffer.toString("utf8");
  }

  return chunks.join("");
}

async function getContainerProtection(id: string) {
  const container = docker.getContainer(id);
  const details = await container.inspect();

  const name = details.Name.replace(/^\//, "");
  const labels = details.Config.Labels ?? {};

  const isSystemContainer =
    protectedContainerNames.has(name) ||
    labels["com.deployment-platform.system"] === "true";

  const isManagedApp =
    labels["com.deployment-platform.managed"] === "true";

  return {
    container,
    details,
    name,
    labels,
    isSystemContainer,
    isManagedApp
  };
}

async function pullImage(image: string): Promise<void> {
  const stream = await docker.pull(image);

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function sendDockerError(
  reply: FastifyReply,
  error: unknown,
  fallbackMessage: string
) {
  app.log.error(error);

  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : 500;

  return reply.code(statusCode).send({
    success: false,
    message: fallbackMessage
  });
}

app.get("/", async () => {
  return {
    name: "Deployment Platform API",
    version: "0.4.0",
    status: "running"
  };
});

app.get("/health", async () => {
  return {
    status: "ok",
    timestamp: new Date().toISOString()
  };
});

app.get("/database/health", async () => {
  return {
    healthy: appDatabase.healthCheck(),
    storedApps: appDatabase.listApps().length
  };
});

function isRoutingReady(hasDomain: boolean): boolean {
  const routingStatus = routingService.getStatus();

  return (
    hasDomain &&
    routingStatus.enabled &&
    routingStatus.lastReconcileSucceeded === true
  );
}

app.get("/apps", async () => {
  return {
    apps: appDatabase.listApps().map((storedApp) => ({
      ...storedApp,
      routingReady: isRoutingReady(storedApp.domain !== null)
    }))
  };
});

app.get("/routing/status", async () => {
  return routingService.getStatus();
});

app.post(
  "/routing/reconcile",
  {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute"
      }
    }
  },
  async () => {
    const status = await routingService.reconcile(appDatabase);

    return {
      success: status.lastReconcileSucceeded === true,
      status
    };
  }
);

app.get("/docker/info", async (_request, reply) => {
  try {
    const info = await docker.info();

    return {
      status: "connected",
      containers: info.Containers,
      containersRunning: info.ContainersRunning,
      containersStopped: info.ContainersStopped,
      images: info.Images,
      dockerVersion: info.ServerVersion,
      operatingSystem: info.OperatingSystem,
      architecture: info.Architecture
    };
  } catch (error) {
    app.log.error(error);

    return reply.code(503).send({
      status: "unavailable",
      message: "Unable to connect to Docker"
    });
  }
});

app.get("/containers", async (_request, reply) => {
  try {
    const containers = await docker.listContainers({
      all: true
    });

    return containers.map((container) => {
      const names = container.Names.map((name) =>
        name.replace(/^\//, "")
      );

      const labels = container.Labels ?? {};

      const isSystemContainer =
        names.some((name) =>
          protectedContainerNames.has(name)
        ) ||
        labels["com.deployment-platform.system"] === "true";

      return {
        id: container.Id,
        shortId: container.Id.slice(0, 12),
        names,
        image: container.Image,
        state: container.State,
        status: container.Status,
        created: container.Created,
        ports: container.Ports,
        labels,
        isSystemContainer,
        isManagedApp:
          labels["com.deployment-platform.managed"] === "true"
      };
    });
  } catch (error) {
    app.log.error(error);

    return reply.code(503).send({
      status: "unavailable",
      message: "Unable to list Docker containers"
    });
  }
});

app.post("/apps", async (request, reply) => {
  const parsedBody = createAppSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return reply.code(400).send({
      success: false,
      message: "Invalid app configuration",
      errors: parsedBody.error.flatten()
    });
  }

  const { name, image, containerPort } = parsedBody.data;
  const containerName = `app-${name}`;
  const exposedPort = `${containerPort}/tcp`;
  const domain = buildAppDomain(name);

  try {
    const storedApp = appDatabase.getAppByName(name);

    if (storedApp) {
      return reply.code(409).send({
        success: false,
        message: `An app named "${name}" already exists`
      });
    }

    const existingDomainApp = appDatabase.getAppByDomain(domain);

    if (existingDomainApp) {
      return reply.code(409).send({
        success: false,
        message: `Domain "${domain}" is already assigned to another app`
      });
    }

    const existingContainers = await docker.listContainers({
      all: true
    });

    const nameAlreadyExists = existingContainers.some(
      (container) =>
        container.Names.includes(`/${containerName}`)
    );

    if (nameAlreadyExists) {
      return reply.code(409).send({
        success: false,
        message: `A container named "${containerName}" already exists`
      });
    }

    const createdApp = appDatabase.createApp({
      name,
      image,
      containerPort,
      containerName,
      domain
    });

    try {
      await pullImage(image);

      const container = await docker.createContainer({
        name: containerName,
        Image: image,
        Labels: {
          "com.deployment-platform.managed": "true",
          "com.deployment-platform.app-name": name
        },
        ExposedPorts: {
          [exposedPort]: {}
        },
        HostConfig: {
          NetworkMode: "deployment-apps",
          RestartPolicy: {
            Name: "unless-stopped"
          }
        }
      });

      await container.start();

      const details = await container.inspect();

      appDatabase.updateAppContainer(createdApp.id, {
        containerId: details.Id,
        status: details.State.Status
      });

      const routingStatus = await routingService.reconcile(appDatabase);

      return reply.code(201).send({
        success: true,
        message:
          routingStatus.lastReconcileSucceeded === false
            ? `App deployed successfully, but routing could not be updated: ${routingStatus.lastError}`
            : "App deployed successfully",
        app: {
          id: details.Id,
          shortId: details.Id.slice(0, 12),
          name,
          containerName,
          image,
          containerPort,
          domain,
          routingReady: isRoutingReady(true),
          state: details.State.Status
        }
      });
    } catch (deploymentError) {
      appDatabase.deleteApp(createdApp.id);
      throw deploymentError;
    }
  } catch (error) {
    return sendDockerError(
      reply,
      error,
      "Unable to deploy app"
    );
  }
});

app.post<{ Params: ContainerParams }>(
  "/containers/:id/start",
  async (request, reply) => {
    try {
      const protection = await getContainerProtection(
        request.params.id
      );

      await protection.container.start();

      return {
        success: true,
        action: "started",
        containerId: request.params.id
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to start container"
      );
    }
  }
);

app.post<{ Params: ContainerParams }>(
  "/containers/:id/stop",
  async (request, reply) => {
    try {
      const protection = await getContainerProtection(
        request.params.id
      );

      if (protection.isSystemContainer) {
        return reply.code(403).send({
          success: false,
          message:
            "System containers cannot be stopped from the dashboard"
        });
      }

      await protection.container.stop({
        t: 10
      });

      return {
        success: true,
        action: "stopped",
        containerId: request.params.id
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to stop container"
      );
    }
  }
);

app.post<{ Params: ContainerParams }>(
  "/containers/:id/restart",
  async (request, reply) => {
    try {
      const protection = await getContainerProtection(
        request.params.id
      );

      if (protection.isSystemContainer) {
        return reply.code(403).send({
          success: false,
          message:
            "System containers cannot be restarted from the dashboard"
        });
      }

      await protection.container.restart({
        t: 10
      });

      return {
        success: true,
        action: "restarted",
        containerId: request.params.id
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to restart container"
      );
    }
  }
);

app.get<{ Params: ContainerParams }>(
  "/containers/:id/logs",
  async (request, reply) => {
    try {
      const container = docker.getContainer(
        request.params.id
      );

      const logs = await container.logs({
        stdout: true,
        stderr: true,
        timestamps: true,
        tail: 200
      });

      return {
        containerId: request.params.id,
        logs: decodeDockerLogs(logs)
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to read container logs"
      );
    }
  }
);

app.delete<{ Params: ContainerParams }>(
  "/apps/:id",
  async (request, reply) => {
    try {
      const protection = await getContainerProtection(
        request.params.id
      );

      if (protection.isSystemContainer) {
        return reply.code(403).send({
          success: false,
          message: "System containers cannot be deleted"
        });
      }

      if (!protection.isManagedApp) {
        return reply.code(403).send({
          success: false,
          message:
            "Only apps created by Deployment Platform can be deleted here"
        });
      }

      const appName =
        protection.labels[
          "com.deployment-platform.app-name"
        ];

      await protection.container.remove({
        force: true,
        v: true
      });

      if (appName) {
        const storedApp = appDatabase.getAppByName(appName);

        if (storedApp) {
          appDatabase.deleteApp(storedApp.id);

          if (storedApp.domain) {
            await routingService.reconcile(appDatabase);
          }
        }
      }

      return {
        success: true,
        action: "deleted",
        containerId: request.params.id,
        name: protection.name,
        appName: appName ?? null
      };
    } catch (error) {
      return sendDockerError(
        reply,
        error,
        "Unable to delete app"
      );
    }
  }
);

const start = async (): Promise<void> => {
  try {
    await app.listen({
      host: "0.0.0.0",
      port: 3001
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  const startupRoutingStatus = await routingService.reconcile(appDatabase);

  if (startupRoutingStatus.enabled && !startupRoutingStatus.lastReconcileSucceeded) {
    app.log.error(
      { routingStatus: startupRoutingStatus },
      "Failed to reconcile routing on startup"
    );
  }
};

await start();