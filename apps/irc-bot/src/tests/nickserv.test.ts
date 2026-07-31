import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { interpretServiceReply, isReservedNickError } from "../nickserv.js";
import { IrcRegistrationError } from "../irc-client.js";

describe("interpretServiceReply", () => {
  test("returns ok when no failure markers are present", () => {
    const result = interpretServiceReply(["Account created for QuiporaBot."]);
    assert.equal(result.ok, true);
    assert.equal(result.message, "Account created for QuiporaBot.");
  });

  test("returns not-ok when the reply mentions an existing registration", () => {
    const result = interpretServiceReply(["Nickname QuiporaBot is already registered."]);
    assert.equal(result.ok, false);
  });

  test("returns not-ok for an IDENTIFY failure", () => {
    const result = interpretServiceReply(["Invalid password."]);
    assert.equal(result.ok, false);
  });

  test("returns not-ok when there is no reply at all", () => {
    const result = interpretServiceReply([]);
    assert.equal(result.ok, false);
    assert.equal(result.message, "No response from NickServ.");
  });

  test("joins multiple reply lines into one message", () => {
    const result = interpretServiceReply(["Line one.", "Line two."]);
    assert.equal(result.message, "Line one. Line two.");
  });
});

describe("isReservedNickError", () => {
  test("recognizes a registration failure mentioning a reserved nick", () => {
    const error = new IrcRegistrationError(
      "Unable to register a connection with the IRC server: Nickname is reserved by a different account"
    );
    assert.equal(isReservedNickError(error), true);
  });

  test("returns false for an unrelated registration error", () => {
    const error = new IrcRegistrationError("Unable to register a connection with the IRC server: Timed out");
    assert.equal(isReservedNickError(error), false);
  });

  test("returns false for a non-registration error", () => {
    assert.equal(isReservedNickError(new Error("Nickname is reserved by a different account")), false);
  });
});
