import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderWelcomeMessage } from "../welcome.js";

describe("renderWelcomeMessage", () => {
  test("substitutes {nick} in the template", () => {
    assert.equal(
      renderWelcomeMessage("Welcome to the server, {nick}!", "alice"),
      "Welcome to the server, alice!"
    );
  });

  test("substitutes every occurrence of {nick}", () => {
    assert.equal(renderWelcomeMessage("hi {nick}, {nick} is here", "bob"), "hi bob, bob is here");
  });

  test("returns null when the template is empty", () => {
    assert.equal(renderWelcomeMessage("", "alice"), null);
  });

  test("returns null when the template is only whitespace", () => {
    assert.equal(renderWelcomeMessage("   ", "alice"), null);
  });
});
