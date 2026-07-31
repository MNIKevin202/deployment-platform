import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findBannedWord } from "../moderation.js";

describe("findBannedWord", () => {
  test("finds a banned word as a case-insensitive substring", () => {
    assert.equal(findBannedWord("that is SPAMmy content", ["spammy"]), "spammy");
  });

  test("returns null when no banned word is present", () => {
    assert.equal(findBannedWord("perfectly fine message", ["spammy", "scam"]), null);
  });

  test("ignores empty entries in the banned word list", () => {
    assert.equal(findBannedWord("hello", ["", "  ", "world"]), null);
  });

  test("returns the first matching word in list order", () => {
    assert.equal(findBannedWord("a scam and spammy message", ["spammy", "scam"]), "spammy");
  });
});
