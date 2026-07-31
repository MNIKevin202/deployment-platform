import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import * as bcrypt from "bcryptjs";
import Docker from "dockerode";
import {
  hashOperatorPassword,
  isIrcServerImage,
  parseGeneralSettings,
  parseOperators,
  readFileFromContainer,
  removeOperator,
  updateGeneralSettings,
  upsertOperator
} from "../services/irc-admin-service.js";

/**
 * Frames a chunk exactly the way Docker's own multiplexed exec stream does
 * (no TTY): an 8-byte header — stream type (1=stdout), 3 reserved bytes,
 * then a big-endian uint32 payload length — followed by the payload itself.
 */
function muxFrame(streamType: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

// A trimmed but structurally faithful excerpt of Ergo's default.yaml, opers
// section, including the comments Ergo ships with — round-tripping through
// this must not destroy them.
const SAMPLE_CONFIG = `# This is the default config file for Ergo.
network:
    name: "ExampleNet"

server:
    name: irc.example.com

opers:
    admin:
        class: "server-admin"
        hidden: true
        whois-line: is the server administrator
        password: "$2a$04$0123456789abcdef0123456789abcdef0123456789abcdef01234"

    #alice:
    #    class: "chat-moderator"
    #    whois-line: "can help with moderation issues!"
    #    password: "$2a$04$0123456789abcdef0123456789abcdef0123456789abcdef01234"

channels:
    # channels that new clients will automatically join. this should be used
    # with caution, since traditional IRC users will likely view it as an
    # antifeature.
    #auto-join:
    #    - "#lounge"

    # modes that are set when new channels are created
    default-modes: +ntC

    max-channels-per-client: 100

    registration:
        enabled: true
        operator-only: false
        max-channels-per-account: 15

accounts:
    registration:
        enabled: true
        allow-before-connect: true
        email-verification:
            enabled: false
`;

describe("readFileFromContainer", () => {
  test("reads a multi-frame multiplexed exec stream back byte-for-byte (regression: a TTY exec previously reflowed and corrupted this)", async () => {
    // Split the config across several frames, interleaved with a stderr
    // frame that must be discarded rather than mixed into the result —
    // exactly what a real multi-KB `cat` produces in multiple chunks.
    const third = Math.floor(SAMPLE_CONFIG.length / 3);
    const part1 = SAMPLE_CONFIG.slice(0, third);
    const part2 = SAMPLE_CONFIG.slice(third, third * 2);
    const part3 = SAMPLE_CONFIG.slice(third * 2);

    const execStream = new PassThrough();
    execStream.write(muxFrame(1, part1));
    execStream.write(muxFrame(2, "some stderr noise\n"));
    execStream.write(muxFrame(1, part2));
    execStream.write(muxFrame(1, part3));
    execStream.end();

    let requestedTty: boolean | undefined;

    const fakeContainer = {
      exec: async (options: { Tty: boolean }) => {
        requestedTty = options.Tty;
        return {
          start: async () => execStream,
          inspect: async () => ({ ExitCode: 0 })
        };
      }
    };

    // A real Docker instance so `.modem.demuxStream` is the actual library
    // implementation, not a hand-rolled stand-in for it.
    const docker = new Docker({ socketPath: "/nonexistent-for-this-test" });
    docker.getContainer = (() => fakeContainer) as unknown as Docker["getContainer"];

    const result = await readFileFromContainer(docker, "container-1", "/ircd/ircd.yaml");

    assert.equal(requestedTty, false);
    assert.equal(result, SAMPLE_CONFIG);
  });

  test("returns null on a non-zero exit code (e.g. file doesn't exist)", async () => {
    const execStream = new PassThrough();
    execStream.end();

    const fakeContainer = {
      exec: async () => ({
        start: async () => execStream,
        inspect: async () => ({ ExitCode: 1 })
      })
    };

    const docker = new Docker({ socketPath: "/nonexistent-for-this-test" });
    docker.getContainer = (() => fakeContainer) as unknown as Docker["getContainer"];

    const result = await readFileFromContainer(docker, "container-1", "/ircd/ircd.motd");
    assert.equal(result, null);
  });
});

describe("isIrcServerImage", () => {
  test("recognizes the Ergo image regardless of tag or registry path", () => {
    assert.equal(isIrcServerImage("ghcr.io/ergochat/ergo:latest"), true);
    assert.equal(isIrcServerImage("ergochat/ergo"), true);
    assert.equal(isIrcServerImage("ghcr.io/ergochat/ergo@sha256:abc123"), true);
  });

  test("rejects unrelated images", () => {
    assert.equal(isIrcServerImage("postgres:16-alpine"), false);
    assert.equal(isIrcServerImage("nginx:alpine"), false);
  });
});

describe("hashOperatorPassword", () => {
  test("produces a bcrypt hash Ergo's own bcrypt verification would accept", async () => {
    const hash = await hashOperatorPassword("correct horse battery staple");
    assert.match(hash, /^\$2[aby]\$\d{2}\$/);
    // A hash Ergo itself could verify with bcrypt.CompareHashAndPassword.
    assert.equal(await bcrypt.compare("correct horse battery staple", hash), true);
    assert.equal(await bcrypt.compare("wrong password", hash), false);
  });
});

describe("parseOperators", () => {
  test("reads the existing admin operator, mapping its class to a role", () => {
    const operators = parseOperators(SAMPLE_CONFIG);
    assert.equal(operators.length, 1);
    assert.equal(operators[0].username, "admin");
    assert.equal(operators[0].role, "admin");
    assert.equal(operators[0].knownRole, true);
  });

  test("never includes password hashes in the parsed result", () => {
    const operators = parseOperators(SAMPLE_CONFIG);
    for (const operator of operators) {
      assert.ok(!("password" in operator));
    }
  });

  test("returns an empty list when there is no opers section", () => {
    const operators = parseOperators("network:\n    name: X\n");
    assert.deepEqual(operators, []);
  });
});

describe("upsertOperator", () => {
  test("adds a new moderator without disturbing the existing admin or file comments", () => {
    const updated = upsertOperator(SAMPLE_CONFIG, {
      username: "bob",
      passwordHash: "$2a$10$fakehashfakehashfakehashfakehashfakehashfakeu",
      role: "moderator"
    });

    const operators = parseOperators(updated);
    const usernames = operators.map((o) => o.username).sort();
    assert.deepEqual(usernames, ["admin", "bob"]);

    const bob = operators.find((o) => o.username === "bob");
    assert.equal(bob?.role, "moderator");

    // The original admin entry and the file's leading comment survive.
    assert.match(updated, /This is the default config file for Ergo/);
    assert.match(updated, /admin:/);
    assert.match(updated, /server-admin/);
  });

  test("replacing an existing operator's role updates it in place rather than duplicating", () => {
    const updated = upsertOperator(SAMPLE_CONFIG, {
      username: "admin",
      passwordHash: "$2a$10$newhashnewhashnewhashnewhashnewhashnewhashn",
      role: "moderator"
    });

    const operators = parseOperators(updated);
    assert.equal(operators.length, 1);
    assert.equal(operators[0].username, "admin");
    assert.equal(operators[0].role, "moderator");
  });

  test("the written password hash is exactly what was passed in", () => {
    const updated = upsertOperator(SAMPLE_CONFIG, {
      username: "carol",
      passwordHash: "$2a$10$exactvalueexactvalueexactvalueexactvalueexa",
      role: "admin"
    });

    assert.match(updated, /\$2a\$10\$exactvalueexactvalueexactvalueexactvalueexa/);
  });
});

describe("removeOperator", () => {
  test("removes the named operator and leaves everything else intact", () => {
    const updated = removeOperator(SAMPLE_CONFIG, "admin");
    assert.deepEqual(parseOperators(updated), []);
    assert.match(updated, /This is the default config file for Ergo/);
    assert.match(updated, /accounts:/);
  });

  test("is a no-op when the username isn't present", () => {
    const updated = removeOperator(SAMPLE_CONFIG, "nobody");
    assert.equal(parseOperators(updated).length, 1);
  });
});

describe("parseGeneralSettings", () => {
  test("reads every field from a config shaped like Ergo's real default.yaml", () => {
    const settings = parseGeneralSettings(SAMPLE_CONFIG);

    assert.equal(settings.networkName, "ExampleNet");
    assert.deepEqual(settings.autoJoinChannels, []); // commented out in the sample, same as Ergo ships by default
    assert.equal(settings.defaultChannelModes, "+ntC");
    assert.equal(settings.maxChannelsPerClient, 100);
    assert.equal(settings.channelRegistrationEnabled, true);
    assert.equal(settings.channelRegistrationOperatorOnly, false);
    assert.equal(settings.maxChannelsPerAccount, 15);
    assert.equal(settings.accountRegistrationEnabled, true);
    assert.equal(settings.allowRegistrationBeforeConnect, true);
    assert.equal(settings.emailVerificationEnabled, false);
  });

  test("falls back sensibly when a section is entirely absent", () => {
    const settings = parseGeneralSettings("network:\n    name: X\n");
    assert.deepEqual(settings.autoJoinChannels, []);
    assert.equal(settings.maxChannelsPerClient, 100);
    assert.equal(settings.accountRegistrationEnabled, true);
  });
});

describe("updateGeneralSettings", () => {
  test("sets auto-join channels, preserving everything else including comments", () => {
    const updated = updateGeneralSettings(SAMPLE_CONFIG, {
      autoJoinChannels: ["#lobby", "#welcome"]
    });

    const settings = parseGeneralSettings(updated);
    assert.deepEqual(settings.autoJoinChannels, ["#lobby", "#welcome"]);
    // Untouched fields keep their original values.
    assert.equal(settings.networkName, "ExampleNet");
    assert.match(updated, /This is the default config file for Ergo/);
    assert.match(updated, /antifeature/);
  });

  test("only changes the fields that were actually provided", () => {
    const updated = updateGeneralSettings(SAMPLE_CONFIG, { networkName: "QuiporaNet" });
    const settings = parseGeneralSettings(updated);

    assert.equal(settings.networkName, "QuiporaNet");
    assert.equal(settings.maxChannelsPerClient, 100);
    assert.equal(settings.channelRegistrationEnabled, true);
  });

  test("round-trips a full settings update through parse -> update -> parse", () => {
    const updated = updateGeneralSettings(SAMPLE_CONFIG, {
      networkName: "QuiporaNet",
      autoJoinChannels: ["#general"],
      defaultChannelModes: "+nt",
      maxChannelsPerClient: 50,
      channelRegistrationEnabled: false,
      channelRegistrationOperatorOnly: true,
      maxChannelsPerAccount: 5,
      accountRegistrationEnabled: false,
      allowRegistrationBeforeConnect: false,
      emailVerificationEnabled: true
    });

    assert.deepEqual(parseGeneralSettings(updated), {
      networkName: "QuiporaNet",
      autoJoinChannels: ["#general"],
      defaultChannelModes: "+nt",
      maxChannelsPerClient: 50,
      channelRegistrationEnabled: false,
      channelRegistrationOperatorOnly: true,
      maxChannelsPerAccount: 5,
      accountRegistrationEnabled: false,
      allowRegistrationBeforeConnect: false,
      emailVerificationEnabled: true
    });
  });
});
