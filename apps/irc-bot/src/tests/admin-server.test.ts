import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";
import { startAdminServer, type BotRuntime } from "../admin-server.js";
import { BotState } from "../state.js";
import { loadConfig } from "../config.js";
import type { Server } from "node:http";

const REQUIRED_ENV = {
  IRC_HOST: "app-quipora-irc",
  IRC_OPER_USER: "bot",
  IRC_OPER_PASS: "secret"
};

let tmpDir: string | null = null;
let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

async function setup(runtimeOverrides: Partial<BotRuntime> = {}) {
  tmpDir = mkdtempSync(join(tmpdir(), "quipora-bot-admin-"));
  const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
  const state = BotState.load(config, join(tmpDir, "bot-state.json"));
  const runtime: BotRuntime = {
    connected: false,
    nick: "QuiporaBot",
    joinedChannels: new Set(["#support"]),
    registerNick: null,
    ...runtimeOverrides
  };

  server = startAdminServer(0, state, runtime);
  await new Promise((resolve) => server?.once("listening", resolve));
  const port = (server?.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { baseUrl, state, runtime };
}

describe("admin server", () => {
  test("GET /status reports runtime connection state", async () => {
    const { baseUrl } = await setup({ connected: true });
    const res = await fetch(`${baseUrl}/status`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.connected, true);
    assert.equal(body.nick, "QuiporaBot");
    assert.deepEqual(body.joinedChannels, ["#support"]);
  });

  test("GET /config returns the current state", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/config`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.commandPrefix, "!");
  });

  test("PUT /config applies and persists a valid patch", async () => {
    const { baseUrl, state } = await setup();
    const res = await fetch(`${baseUrl}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rulesText: "Be nice." })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.rulesText, "Be nice.");
    assert.equal(state.get().rulesText, "Be nice.");
  });

  test("PUT /config rejects an invalid patch with 400", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moderationAction: "ban" })
    });
    assert.equal(res.status, 400);
  });

  test("POST /register-nick returns 503 when not connected", async () => {
    const { baseUrl } = await setup({ registerNick: null });
    const res = await fetch(`${baseUrl}/register-nick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "hunter2" })
    });
    assert.equal(res.status, 503);
  });

  test("POST /register-nick requires a password", async () => {
    const { baseUrl } = await setup({ registerNick: async () => ({ ok: true, message: "done" }) });
    const res = await fetch(`${baseUrl}/register-nick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  test("POST /register-nick calls through to the runtime and returns its result", async () => {
    let receivedPassword: string | undefined;
    const { baseUrl } = await setup({
      registerNick: async (password) => {
        receivedPassword = password;
        return { ok: true, message: "Account created." };
      }
    });

    const res = await fetch(`${baseUrl}/register-nick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "hunter2" })
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(receivedPassword, "hunter2");
  });

  test("returns 404 for an unknown route", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
  });
});
