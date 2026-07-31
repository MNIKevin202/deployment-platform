import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseIrcLine } from "../services/irc-client-service.js";

// Every line below is real, captured from a live Ergo v2.19.0 server.

describe("parseIrcLine", () => {
  test("parses a numeric reply with a prefix and trailing text", () => {
    const line = parseIrcLine(":ergo.test 381 svctest :You are now an IRC operator");
    assert.equal(line.prefix, "ergo.test");
    assert.equal(line.command, "381");
    assert.deepEqual(line.params, ["svctest", "You are now an IRC operator"]);
  });

  test("parses a NOTICE from ChanServ with a nick!user@host prefix", () => {
    const line = parseIrcLine(
      ":ChanServ!ChanServ@localhost NOTICE svctest :*** ChanServ LIST ***"
    );
    assert.equal(line.prefix, "ChanServ!ChanServ@localhost");
    assert.equal(line.command, "NOTICE");
    assert.deepEqual(line.params, ["svctest", "*** ChanServ LIST ***"]);
  });

  test("parses RPL_ISUPPORT (005), which has many space-separated middle params before the trailing", () => {
    const line = parseIrcLine(
      ":ergo.test 005 svctest AWAYLEN=390 BOT=B CASEMAPPING=ascii :are supported by this server"
    );
    assert.equal(line.command, "005");
    assert.deepEqual(line.params, [
      "svctest",
      "AWAYLEN=390",
      "BOT=B",
      "CASEMAPPING=ascii",
      "are supported by this server"
    ]);
  });

  test("parses a command with no prefix", () => {
    const line = parseIrcLine("PRIVMSG ChanServ :LIST");
    assert.equal(line.prefix, null);
    assert.equal(line.command, "PRIVMSG");
    assert.deepEqual(line.params, ["ChanServ", "LIST"]);
  });

  test("parses a line with no trailing param at all", () => {
    const line = parseIrcLine(":ergo.test MODE svctest +o");
    assert.equal(line.command, "MODE");
    assert.deepEqual(line.params, ["svctest", "+o"]);
  });
});
