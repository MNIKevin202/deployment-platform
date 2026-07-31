import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";
import {
  BotAdminUnreachableError,
  findLinkedBotApp,
  getBotConfig,
  getBotStatus,
  isIrcBotImage,
  registerBotNick,
  updateBotConfig,
  type BotAppCandidate
} from "../services/irc-bot-admin-service.js";

describe("isIrcBotImage", () => {
  test("matches the Quipora Bot image regardless of registry/namespace/tag", () => {
    assert.equal(isIrcBotImage("ghcr.io/mnikevin202/quipora-bot:latest"), true);
    assert.equal(isIrcBotImage("quipora-bot"), true);
    assert.equal(isIrcBotImage("QUIPORA-BOT:v2"), true);
  });

  test("rejects unrelated images", () => {
    assert.equal(isIrcBotImage("ghcr.io/ergochat/ergo:latest"), false);
    assert.equal(isIrcBotImage("postgres:16"), false);
  });
});

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
  }
});

async function startFakeBot(handler: http.RequestListener): Promise<{ host: string; port: number }> {
  server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server?.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { host: "127.0.0.1", port: address.port };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

describe("getBotStatus / getBotConfig", () => {
  test("fetches and parses status from the bot's admin API", async () => {
    const { host, port } = await startFakeBot((req, res) => {
      if (req.url === "/status") {
        sendJson(res, 200, { connected: true, nick: "QuiporaBot", nickRegistered: false, joinedChannels: ["#a"] });
        return;
      }
      sendJson(res, 404, {});
    });

    const status = await getBotStatus(host, port);
    assert.equal(status.connected, true);
    assert.deepEqual(status.joinedChannels, ["#a"]);
  });

  test("throws BotAdminUnreachableError on a non-2xx response", async () => {
    const { host, port } = await startFakeBot((_req, res) => sendJson(res, 500, {}));
    await assert.rejects(() => getBotConfig(host, port), BotAdminUnreachableError);
  });

  test("throws BotAdminUnreachableError when the port isn't listening", async () => {
    await assert.rejects(() => getBotStatus("127.0.0.1", 1), BotAdminUnreachableError);
  });
});

describe("updateBotConfig", () => {
  test("returns ok:true with the updated config on success", async () => {
    let receivedBody: unknown = null;
    const { host, port } = await startFakeBot((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        sendJson(res, 200, { rulesText: "Be nice.", commandPrefix: "!" });
      });
    });

    const result = await updateBotConfig(host, port, { rulesText: "Be nice." });
    assert.equal(result.ok, true);
    assert.deepEqual(receivedBody, { rulesText: "Be nice." });
  });

  test("returns ok:false with the bot's error message on a validation failure", async () => {
    const { host, port } = await startFakeBot((_req, res) => sendJson(res, 400, { message: "bad patch" }));
    const result = await updateBotConfig(host, port, { moderationAction: "invalid" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.message, "bad patch");
    }
  });
});

describe("registerBotNick", () => {
  test("posts the password (and omits email when absent)", async () => {
    let receivedBody: unknown = null;
    const { host, port } = await startFakeBot((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        sendJson(res, 200, { ok: true, message: "Account created." });
      });
    });

    const { status, result } = await registerBotNick(host, port, "hunter2");
    assert.equal(status, 200);
    assert.equal(result.ok, true);
    assert.deepEqual(receivedBody, { password: "hunter2" });
  });

  test("includes the email when provided", async () => {
    let receivedBody: unknown = null;
    const { host, port } = await startFakeBot((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        sendJson(res, 200, { ok: true, message: "ok" });
      });
    });

    await registerBotNick(host, port, "hunter2", "admin@example.com");
    assert.deepEqual(receivedBody, { password: "hunter2", email: "admin@example.com" });
  });
});

describe("findLinkedBotApp", () => {
  const ircContainer = "app-quipora-irc";

  function candidate(overrides: Partial<BotAppCandidate> = {}): BotAppCandidate {
    return {
      id: 1,
      image: "ghcr.io/mnikevin202/quipora-bot:latest",
      containerName: "app-quipora-bot",
      containerId: "c1",
      ...overrides
    };
  }

  test("finds the bot app whose IRC_HOST env var matches the IRC container", () => {
    const apps = [candidate({ id: 1 })];
    const envVars = (appId: number) =>
      appId === 1 ? [{ key: "IRC_HOST", value: ircContainer }] : [];

    assert.deepEqual(findLinkedBotApp(apps, envVars, ircContainer), candidate({ id: 1 }));
  });

  test("ignores non-bot-image apps", () => {
    const apps = [candidate({ id: 1, image: "postgres:16" })];
    const envVars = () => [{ key: "IRC_HOST", value: ircContainer }];

    assert.equal(findLinkedBotApp(apps, envVars, ircContainer), null);
  });

  test("ignores a bot app pointed at a different IRC server", () => {
    const apps = [candidate({ id: 1 })];
    const envVars = () => [{ key: "IRC_HOST", value: "app-some-other-irc" }];

    assert.equal(findLinkedBotApp(apps, envVars, ircContainer), null);
  });

  test("returns null when there are no candidate apps at all", () => {
    assert.equal(findLinkedBotApp([], () => [], ircContainer), null);
  });

  test("returns the first match when multiple bot apps somehow point at the same server", () => {
    const apps = [candidate({ id: 1 }), candidate({ id: 2 })];
    const envVars = () => [{ key: "IRC_HOST", value: ircContainer }];

    assert.equal(findLinkedBotApp(apps, envVars, ircContainer)?.id, 1);
  });
});
