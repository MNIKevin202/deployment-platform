import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateConfigPatch } from "../config-patch.js";

describe("validateConfigPatch", () => {
  test("accepts a valid partial patch", () => {
    const result = validateConfigPatch({ rulesText: "Be nice.", moderationAction: "kick" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.patch, { rulesText: "Be nice.", moderationAction: "kick" });
    }
  });

  test("accepts an empty object as a no-op patch", () => {
    const result = validateConfigPatch({});
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.patch, {});
    }
  });

  test("rejects a non-object body", () => {
    assert.equal(validateConfigPatch("nope").ok, false);
    assert.equal(validateConfigPatch(null).ok, false);
    assert.equal(validateConfigPatch([1, 2]).ok, false);
  });

  test("rejects an empty commandPrefix", () => {
    const result = validateConfigPatch({ commandPrefix: "" });
    assert.equal(result.ok, false);
  });

  test("rejects botCommands with a non-string value", () => {
    const result = validateConfigPatch({ botCommands: { "!x": 5 } });
    assert.equal(result.ok, false);
  });

  test("accepts a valid botCommands map", () => {
    const result = validateConfigPatch({ botCommands: { "!discord": "https://discord.example" } });
    assert.equal(result.ok, true);
  });

  test("rejects bannedWords that isn't an array of strings", () => {
    assert.equal(validateConfigPatch({ bannedWords: "spam" }).ok, false);
    assert.equal(validateConfigPatch({ bannedWords: [1, 2] }).ok, false);
  });

  test("rejects an invalid moderationAction", () => {
    assert.equal(validateConfigPatch({ moderationAction: "ban" }).ok, false);
  });
});
