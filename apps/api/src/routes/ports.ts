import type { FastifyInstance } from "fastify";
import type { AppDatabase } from "../database.js";

interface RegisterPortsRoutesOptions {
  appDatabase: AppDatabase;
}

const SUGGEST_MIN = 3000;
const SUGGEST_MAX = 9999;
const SCAN_MIN = 1024;
const SCAN_MAX = 65535;

/**
 * Picks a container port not already assigned to a managed app. Managed apps
 * run on a shared Docker network with no host-port publishing, so ports can't
 * truly collide across apps — this just keeps each app's declared port
 * distinct and out of the way. Tries a few random ports in a friendly range
 * first (so suggestions aren't predictable), then falls back to scanning.
 */
export function suggestAvailablePort(
  usedPorts: ReadonlySet<number>,
  random: () => number = Math.random
): number {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = SUGGEST_MIN + Math.floor(random() * (SUGGEST_MAX - SUGGEST_MIN + 1));
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  for (let port = SCAN_MIN; port <= SCAN_MAX; port += 1) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  return SUGGEST_MIN;
}

export async function registerPortsRoutes(
  fastify: FastifyInstance,
  { appDatabase }: RegisterPortsRoutesOptions
): Promise<void> {
  fastify.get(
    "/ports/suggest",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async () => {
      const usedPorts = new Set(appDatabase.listApps().map((app) => app.containerPort));
      return { success: true, port: suggestAvailablePort(usedPorts) };
    }
  );
}
