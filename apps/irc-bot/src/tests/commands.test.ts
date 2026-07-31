import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { matchCommand } from "../commands.js";

const ctx = {
  prefix: "!",
  rulesText: "Be nice.",
  customCommands: { "!discord": "https://discord.example/invite" }
};

describe("matchCommand", () => {
  test("returns the built-in help text listing all commands", () => {
    assert.equal(matchCommand("!help", ctx), "Commands: !help, !rules, !discord");
  });

  test("returns the configured rules text for !rules", () => {
    assert.equal(matchCommand("!rules", ctx), "Be nice.");
  });

  test("falls back to a default message when no rules are configured", () => {
    assert.equal(
      matchCommand("!rules", { ...ctx, rulesText: "" }),
      "No rules have been configured for this server."
    );
  });

  test("returns a custom command's configured reply", () => {
    assert.equal(matchCommand("!discord", ctx), "https://discord.example/invite");
  });

  test("matches only the first word, ignoring trailing arguments", () => {
    assert.equal(matchCommand("!rules please", ctx), "Be nice.");
  });

  test("returns null for a message that isn't a command", () => {
    assert.equal(matchCommand("hey everyone", ctx), null);
  });

  test("returns null for an unrecognized command", () => {
    assert.equal(matchCommand("!nope", ctx), null);
  });

  test("respects a custom prefix", () => {
    assert.equal(matchCommand(".rules", { ...ctx, prefix: "." }), "Be nice.");
    assert.equal(matchCommand("!rules", { ...ctx, prefix: "." }), null);
  });
});
