import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { BotState, mergeState, stateFromConfig, type BotStateData } from "../state.js";
import { loadConfig } from "../config.js";

const REQUIRED_ENV = {
  IRC_HOST: "app-quipora-irc",
  IRC_OPER_USER: "bot",
  IRC_OPER_PASS: "secret"
};

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "quipora-bot-state-"));
  return tmpDir;
}

describe("stateFromConfig", () => {
  test("seeds mutable fields from config, starting unregistered", () => {
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
    const state = stateFromConfig(config);
    assert.equal(state.commandPrefix, "!");
    assert.equal(state.nickRegistered, false);
  });
});

describe("mergeState", () => {
  const base: BotStateData = {
    welcomeMessageTemplate: "",
    commandPrefix: "!",
    rulesText: "",
    botCommands: {},
    bannedWords: [],
    moderationAction: "warn",
    nickRegistered: false
  };

  test("returns the base state when there's nothing persisted", () => {
    assert.deepEqual(mergeState(base, null), base);
  });

  test("a persisted file overrides matching base fields", () => {
    const merged = mergeState(base, { rulesText: "Custom rules", nickRegistered: true });
    assert.equal(merged.rulesText, "Custom rules");
    assert.equal(merged.nickRegistered, true);
    assert.equal(merged.commandPrefix, "!");
  });
});

describe("BotState", () => {
  test("loads defaults when no state file exists yet", () => {
    const dir = makeTmpDir();
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
    const state = BotState.load(config, join(dir, "bot-state.json"));
    assert.equal(state.get().commandPrefix, "!");
  });

  test("update() merges a partial patch and persists it to disk", () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "bot-state.json");
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
    const state = BotState.load(config, filePath);

    const updated = state.update({ rulesText: "Be nice.", bannedWords: ["spam"] });
    assert.equal(updated.rulesText, "Be nice.");
    assert.deepEqual(updated.bannedWords, ["spam"]);
    assert.equal(updated.commandPrefix, "!", "unpatched fields are preserved");

    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(persisted.rulesText, "Be nice.");
  });

  test("a later load() picks up the persisted state from a previous run", () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "bot-state.json");
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);

    BotState.load(config, filePath).update({ commandPrefix: "." });

    const reloaded = BotState.load(config, filePath);
    assert.equal(reloaded.get().commandPrefix, ".");
  });

  test("setNickRegistered() persists the registration flag", () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "bot-state.json");
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
    const state = BotState.load(config, filePath);

    state.setNickRegistered(true);
    assert.equal(state.get().nickRegistered, true);

    const reloaded = BotState.load(config, filePath);
    assert.equal(reloaded.get().nickRegistered, true);
  });

  test("get() returns a defensive copy of mutable collections", () => {
    const dir = makeTmpDir();
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
    const state = BotState.load(config, join(dir, "bot-state.json"));

    const snapshot = state.get();
    snapshot.bannedWords.push("mutated");
    assert.deepEqual(state.get().bannedWords, []);
  });
});
