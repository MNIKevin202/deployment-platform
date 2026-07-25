import Fastify from "fastify";
import cors from "@fastify/cors";

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});

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
