import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shouldKickForBlockedChannel } from "../block.js";

describe("shouldKickForBlockedChannel", () => {
  test("kicks a joiner in a blocked channel", () => {
    assert.equal(shouldKickForBlockedChannel("#banned", "someone", "QuiporaBot", ["#banned"]), true);
  });

  test("does not kick in a channel that isn't blocked", () => {
    assert.equal(shouldKickForBlockedChannel("#general", "someone", "QuiporaBot", ["#banned"]), false);
  });

  test("never kicks the bot's own join", () => {
    assert.equal(shouldKickForBlockedChannel("#banned", "QuiporaBot", "QuiporaBot", ["#banned"]), false);
  });

  test("returns false when nothing is blocked", () => {
    assert.equal(shouldKickForBlockedChannel("#general", "someone", "QuiporaBot", []), false);
  });
});
