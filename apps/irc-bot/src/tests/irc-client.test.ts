import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseIrcLine, prefixNick } from "../irc-client.js";

describe("parseIrcLine", () => {
  test("parses a JOIN with a full nick!user@host prefix", () => {
    const line = parseIrcLine(":alice!alice@localhost JOIN #general");
    assert.equal(line.prefix, "alice!alice@localhost");
    assert.equal(line.command, "JOIN");
    assert.deepEqual(line.params, ["#general"]);
  });

  test("parses a PRIVMSG with a trailing message", () => {
    const line = parseIrcLine(":alice!alice@localhost PRIVMSG #general :hello there");
    assert.equal(line.command, "PRIVMSG");
    assert.deepEqual(line.params, ["#general", "hello there"]);
  });
});

describe("prefixNick", () => {
  test("extracts the nick from a full prefix", () => {
    assert.equal(prefixNick("alice!alice@localhost"), "alice");
  });

  test("returns the whole prefix when there's no user@host part", () => {
    assert.equal(prefixNick("ergo.test"), "ergo.test");
  });

  test("returns null for a null prefix", () => {
    assert.equal(prefixNick(null), null);
  });
});
