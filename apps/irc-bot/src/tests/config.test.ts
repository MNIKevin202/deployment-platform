import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../config.js";

const REQUIRED_ENV = {
  IRC_HOST: "app-quipora-irc",
  IRC_OPER_USER: "bot",
  IRC_OPER_PASS: "secret"
};

describe("loadConfig", () => {
  test("applies defaults when optional vars are absent", () => {
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
    assert.equal(config.port, 6697);
    assert.equal(config.nick, "QuiporaBot");
    assert.equal(config.joinPollIntervalSeconds, 30);
    assert.equal(config.commandPrefix, "!");
    assert.equal(config.moderationAction, "warn");
    assert.deepEqual(config.botCommands, {});
    assert.deepEqual(config.bannedWords, []);
    assert.equal(config.stateFilePath, "/data/bot-state.json");
    assert.equal(config.adminPort, 3000);
  });

  test("throws a clear error when a required var is missing", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /IRC_HOST/);
  });

  test("parses BOT_COMMANDS JSON and BANNED_WORDS csv", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      BOT_COMMANDS: '{"!discord":"https://discord.example"}',
      BANNED_WORDS: "spam, scam , "
    } as NodeJS.ProcessEnv);
    assert.deepEqual(config.botCommands, { "!discord": "https://discord.example" });
    assert.deepEqual(config.bannedWords, ["spam", "scam"]);
  });

  test("falls back to an empty command map on invalid JSON", () => {
    const config = loadConfig({ ...REQUIRED_ENV, BOT_COMMANDS: "not json" } as NodeJS.ProcessEnv);
    assert.deepEqual(config.botCommands, {});
  });

  test("only accepts 'kick' as a non-default moderation action", () => {
    const config = loadConfig({ ...REQUIRED_ENV, MODERATION_ACTION: "kick" } as NodeJS.ProcessEnv);
    assert.equal(config.moderationAction, "kick");

    const fallback = loadConfig({ ...REQUIRED_ENV, MODERATION_ACTION: "ban" } as NodeJS.ProcessEnv);
    assert.equal(fallback.moderationAction, "warn");
  });
});
