import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractConfirmationCode, parseChannelInfo } from "../services/irc-channel-service.js";

// Every fixture below is the exact NOTICE text captured from a real Ergo
// v2.19.0 instance (ChanServ LIST/INFO/UNREGISTER/TRANSFER), not guessed —
// see the session that built this feature for the raw session transcripts.

describe("parseChannelInfo", () => {
  test("parses a registered channel's founder and registration date", () => {
    const lines = [
      "Channel #svctestchan is registered",
      "Founder: svctest",
      "Registered at: Fri, 31 Jul 2026 16:13:27 UTC"
    ];

    assert.deepEqual(parseChannelInfo(lines, "#svctestchan"), {
      name: "#svctestchan",
      founder: "svctest",
      registeredAt: "Fri, 31 Jul 2026 16:13:27 UTC"
    });
  });

  test("returns null for an unregistered channel rather than a half-filled object", () => {
    const lines = ["Channel #support is not registered"];
    assert.equal(parseChannelInfo(lines, "#support"), null);
  });

  test("still returns a result (with nulls) if founder/registered-at lines are unexpectedly missing", () => {
    const lines = ["Channel #x is registered"];
    assert.deepEqual(parseChannelInfo(lines, "#x"), {
      name: "#x",
      founder: null,
      registeredAt: null
    });
  });
});

describe("extractConfirmationCode", () => {
  test("extracts the code from a real UNREGISTER confirmation prompt", () => {
    const lines = [
      "Warning: unregistering this channel will remove all stored channel attributes.",
      "To confirm, run this command: /CS UNREGISTER #svctestchan nqys6"
    ];
    assert.equal(extractConfirmationCode(lines), "nqys6");
  });

  test("extracts the code from a real NickServ UNREGISTER confirmation prompt (same phrasing, different command)", () => {
    const lines = [
      "Warning: unregistering this account will remove its stored privileges.",
      "To confirm, run this command: /NS UNREGISTER svctest xxkwi"
    ];
    assert.equal(extractConfirmationCode(lines), "xxkwi");
  });

  test("returns null when there's no confirmation prompt to extract", () => {
    assert.equal(extractConfirmationCode(["Channel #x is now unregistered"]), null);
  });
});
