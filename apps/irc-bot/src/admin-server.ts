import * as http from "node:http";
import { validateConfigPatch } from "./config-patch.js";
import type { ServiceCommandResult } from "./nickserv.js";
import type { BotState } from "./state.js";

/**
 * The parts of the live IRC connection the admin API needs to reach — set by
 * index.ts's runConnection() while connected, cleared on disconnect. There is
 * never more than one active connection, so this is a single shared handle
 * rather than something passed per-request.
 */
export interface BotRuntime {
  connected: boolean;
  nick: string;
  joinedChannels: Set<string>;
  registerNick: ((password: string, email?: string) => Promise<ServiceCommandResult>) | null;
}

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });

    req.on("error", reject);
  });
}

export function startAdminServer(port: number, state: BotState, runtime: BotRuntime): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, state, runtime);
  });

  server.listen(port, "0.0.0.0");
  return server;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: BotState,
  runtime: BotRuntime
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  try {
    if (method === "GET" && url === "/status") {
      sendJson(res, 200, {
        connected: runtime.connected,
        nick: runtime.nick,
        nickRegistered: state.get().nickRegistered,
        joinedChannels: [...runtime.joinedChannels]
      });
      return;
    }

    if (method === "GET" && url === "/config") {
      sendJson(res, 200, state.get());
      return;
    }

    if (method === "PUT" && url === "/config") {
      const body = await readJsonBody(req);
      const result = validateConfigPatch(body);
      if (!result.ok) {
        sendJson(res, 400, { message: result.message });
        return;
      }
      sendJson(res, 200, state.update(result.patch));
      return;
    }

    if (method === "POST" && url === "/register-nick") {
      if (!runtime.registerNick) {
        sendJson(res, 503, { ok: false, message: "Not currently connected to the IRC server." });
        return;
      }

      const body = await readJsonBody(req);
      const input = body as { password?: unknown; email?: unknown };
      if (typeof input.password !== "string" || input.password.length === 0) {
        sendJson(res, 400, { message: "password is required." });
        return;
      }
      const email = typeof input.email === "string" && input.email.length > 0 ? input.email : undefined;

      const result = await runtime.registerNick(input.password, email);
      sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    sendJson(res, 404, { message: "Not found" });
  } catch (error) {
    sendJson(res, 400, { message: error instanceof Error ? error.message : "Invalid request" });
  }
}
