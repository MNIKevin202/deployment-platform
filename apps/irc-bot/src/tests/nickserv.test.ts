import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { interpretRegisterReply } from "../nickserv.js";

describe("interpretRegisterReply", () => {
  test("returns ok when no failure markers are present", () => {
    const result = interpretRegisterReply(["Account created for QuiporaBot."]);
    assert.equal(result.ok, true);
    assert.equal(result.message, "Account created for QuiporaBot.");
  });

  test("returns not-ok when the reply mentions an existing registration", () => {
    const result = interpretRegisterReply(["Nickname QuiporaBot is already registered."]);
    assert.equal(result.ok, false);
  });

  test("returns not-ok when there is no reply at all", () => {
    const result = interpretRegisterReply([]);
    assert.equal(result.ok, false);
    assert.equal(result.message, "No response from NickServ.");
  });

  test("joins multiple reply lines into one message", () => {
    const result = interpretRegisterReply(["Line one.", "Line two."]);
    assert.equal(result.message, "Line one. Line two.");
  });
});
