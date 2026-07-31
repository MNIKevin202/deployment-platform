import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { channelsFromListReply, channelsToJoin } from "../joins.js";
import type { IrcLine } from "../irc-client.js";

function listLine(channel: string): IrcLine {
  return {
    raw: `:ergo.test 322 QuiporaBot ${channel} 3 :some topic`,
    prefix: "ergo.test",
    command: "322",
    params: ["QuiporaBot", channel, "3", "some topic"]
  };
}

describe("channelsFromListReply", () => {
  test("extracts channel names from RPL_LIST (322) lines", () => {
    const lines = [listLine("#general"), listLine("#support")];
    assert.deepEqual(channelsFromListReply(lines), ["#general", "#support"]);
  });

  test("ignores non-322 lines mixed into the reply", () => {
    const notListEnd: IrcLine = {
      raw: ":ergo.test 323 QuiporaBot :End of /LIST",
      prefix: "ergo.test",
      command: "323",
      params: ["QuiporaBot", "End of /LIST"]
    };
    assert.deepEqual(channelsFromListReply([listLine("#general"), notListEnd]), ["#general"]);
  });

  test("returns an empty array when there are no channels", () => {
    assert.deepEqual(channelsFromListReply([]), []);
  });
});

describe("channelsToJoin", () => {
  test("returns channels not already in the joined set", () => {
    const joined = new Set(["#general"]);
    assert.deepEqual(channelsToJoin(["#general", "#support", "#new-channel"], joined), [
      "#support",
      "#new-channel"
    ]);
  });

  test("compares case-insensitively", () => {
    const joined = new Set(["#General"]);
    assert.deepEqual(channelsToJoin(["#general"], joined), []);
  });

  test("returns an empty array when everything is already joined", () => {
    const joined = new Set(["#general", "#support"]);
    assert.deepEqual(channelsToJoin(["#general", "#support"], joined), []);
  });
});
