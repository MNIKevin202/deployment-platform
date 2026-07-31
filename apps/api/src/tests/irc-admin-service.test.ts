import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as bcrypt from "bcryptjs";
import {
  hashOperatorPassword,
  isIrcServerImage,
  parseOperators,
  removeOperator,
  upsertOperator
} from "../services/irc-admin-service.js";

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

accounts:
    registration:
        enabled: true
`;

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
