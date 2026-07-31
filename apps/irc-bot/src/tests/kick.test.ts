import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseKick } from "../kick.js";
import type { IrcLine } from "../irc-client.js";

function line(command: string, params: string[]): IrcLine {
  return { raw: "", prefix: "someone!u@h", command, params };
}

describe("parseKick", () => {
  test("extracts the channel and kicked nick", () => {
    assert.deepEqual(parseKick(line("KICK", ["#support", "QuiporaBot", "bye"])), {
      channel: "#support",
      target: "QuiporaBot"
    });
  });

  test("returns null for a non-KICK line", () => {
    assert.equal(parseKick(line("PART", ["#support"])), null);
  });

  test("returns null when the line is missing a target", () => {
    assert.equal(parseKick(line("KICK", ["#support"])), null);
  });
});
