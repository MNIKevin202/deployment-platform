import Fastify from "fastify";
import cors from "@fastify/cors";
import { docker } from "./docker.js";

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});

interface ContainerParams {
  id: string;
}

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

    chunks.push(buffer.subarray(payloadStart, payloadEnd).toString("utf8"));
    offset = payloadEnd;
  }

  if (chunks.length === 0) {
    return buffer.toString("utf8");
  }

  return chunks.join("");
}

app.get("/", async () => {
  return {
    name: "Deployment Platform API",
    version: "0.1.0",
    status: "running"
  };
});

app.get("/health", async () => {
  return {
    status: "ok",
    timestamp: new Date().toISOString()
  };
});

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

    return containers.map((container) => ({
      id: container.Id,
      shortId: container.Id.slice(0, 12),
      names: container.Names.map((name) => name.replace(/^\//, "")),
      image: container.Image,
      state: container.State,
      status: container.Status,
      created: container.Created,
      ports: container.Ports
    }));
  } catch (error) {
    app.log.error(error);

    return reply.code(503).send({
      status: "unavailable",
      message: "Unable to list Docker containers"
    });
  }
});

app.post<{ Params: ContainerParams }>(
  "/containers/:id/start",
  async (request, reply) => {
    try {
      const container = docker.getContainer(request.params.id);
      await container.start();

      return {
        success: true,
        action: "started",
        containerId: request.params.id
      };
    } catch (error) {
      app.log.error(error);

      return reply.code(500).send({
        success: false,
        message: "Unable to start container"
      });
    }
  }
);

app.post<{ Params: ContainerParams }>(
  "/containers/:id/stop",
  async (request, reply) => {
    try {
      const container = docker.getContainer(request.params.id);

      await container.stop({
        t: 10
      });

      return {
        success: true,
        action: "stopped",
        containerId: request.params.id
      };
    } catch (error) {
      app.log.error(error);

      return reply.code(500).send({
        success: false,
        message: "Unable to stop container"
      });
    }
  }
);

app.post<{ Params: ContainerParams }>(
  "/containers/:id/restart",
  async (request, reply) => {
    try {
      const container = docker.getContainer(request.params.id);

      await container.restart({
        t: 10
      });

      return {
        success: true,
        action: "restarted",
        containerId: request.params.id
      };
    } catch (error) {
      app.log.error(error);

      return reply.code(500).send({
        success: false,
        message: "Unable to restart container"
      });
    }
  }
);

app.get<{ Params: ContainerParams }>(
  "/containers/:id/logs",
  async (request, reply) => {
    try {
      const container = docker.getContainer(request.params.id);

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
      app.log.error(error);

      return reply.code(500).send({
        success: false,
        message: "Unable to read container logs"
      });
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
};

await start();
