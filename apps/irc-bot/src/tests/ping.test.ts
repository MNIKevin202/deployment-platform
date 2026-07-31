import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pongReply } from "../ping.js";
import type { IrcLine } from "../irc-client.js";

function line(command: string, params: string[]): IrcLine {
  return { raw: "", prefix: null, command, params };
}

describe("pongReply", () => {
  test("replies with the server's PING token", () => {
    assert.equal(pongReply(line("PING", ["ergo.test"])), "PONG :ergo.test");
  });

  test("returns null for a non-PING line", () => {
    assert.equal(pongReply(line("PRIVMSG", ["#general", "hi"])), null);
  });

  test("handles a PING with no token", () => {
    assert.equal(pongReply(line("PING", [])), "PONG :");
  });
});
