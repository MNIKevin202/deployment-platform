import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseConnectionTarget,
  resolveEndpoint,
  testConnection
} from "../connection-test.js";

describe("parseConnectionTarget", () => {
  test("parses a MongoDB SRV URI and flags it as srv", () => {
    const target = parseConnectionTarget(
      "mongodb+srv://user:pw@cluster0.ab12c.mongodb.net/?retryWrites=true"
    );
    assert.equal(target?.host, "cluster0.ab12c.mongodb.net");
    assert.equal(target?.isSrv, true);
    assert.equal(target?.baseScheme, "mongodb");
    assert.equal(target?.port, null);
  });

  test("parses an explicit host and port", () => {
    const target = parseConnectionTarget("postgresql://u:p@db.example.com:6543/app");
    assert.equal(target?.host, "db.example.com");
    assert.equal(target?.port, 6543);
    assert.equal(target?.isSrv, false);
    assert.equal(target?.baseScheme, "postgresql");
  });

  test("returns null for an unparseable / multi-host string", () => {
    assert.equal(parseConnectionTarget("mongodb://a:1,b:2/db"), null);
    assert.equal(parseConnectionTarget("not a uri"), null);
    assert.equal(parseConnectionTarget("   "), null);
  });
});

describe("resolveEndpoint", () => {
  test("resolves an SRV target via the DNS resolver", async () => {
    const target = parseConnectionTarget("mongodb+srv://u:p@cluster0.x.mongodb.net/")!;
    const endpoint = await resolveEndpoint(target, async (hostname) => {
      assert.equal(hostname, "_mongodb._tcp.cluster0.x.mongodb.net");
      return [{ name: "shard-00-00.x.mongodb.net", port: 27017 }];
    });
    assert.deepEqual(endpoint, {
      host: "shard-00-00.x.mongodb.net",
      port: 27017
    });
  });

  test("throws when SRV resolution yields no records", async () => {
    const target = parseConnectionTarget("mongodb+srv://u:p@cluster0.x.mongodb.net/")!;
    await assert.rejects(() => resolveEndpoint(target, async () => []));
  });

  test("fills the default port for a known scheme when none is given", async () => {
    const target = parseConnectionTarget("redis://cache.example.com/")!;
    const endpoint = await resolveEndpoint(target);
    assert.deepEqual(endpoint, { host: "cache.example.com", port: 6379 });
  });
});

describe("testConnection", () => {
  test("reports reachable when the probe connects", async () => {
    const result = await testConnection(
      "mongodb+srv://u:p@cluster0.x.mongodb.net/",
      {
        resolveSrv: async () => [{ name: "shard.x.mongodb.net", port: 27017 }],
        probe: async () => {}
      }
    );
    assert.equal(result.reachable, true);
    assert.match(result.message, /shard\.x\.mongodb\.net:27017/);
  });

  test("reports unreachable with the probe's error when the connection fails", async () => {
    const result = await testConnection("postgresql://u:p@db.example.com:5432/app", {
      probe: async () => {
        throw new Error("ECONNREFUSED");
      }
    });
    assert.equal(result.reachable, false);
    assert.match(result.message, /db\.example\.com:5432/);
    assert.match(result.message, /ECONNREFUSED/);
  });

  test("reports a clear message for an unparseable string, without probing", async () => {
    let probed = false;
    const result = await testConnection("garbage", {
      probe: async () => {
        probed = true;
      }
    });
    assert.equal(result.reachable, false);
    assert.equal(probed, false);
  });
});
