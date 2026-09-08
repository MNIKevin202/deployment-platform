import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  CLEARED_DNS_SEARCH,
  MANAGED_APPS_NETWORK,
  ensureManagedNameResolves,
  managedAppNetworkHostConfig
} from "../services/managed-app-network.js";

const SERVICES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "services");

/** Every path that creates a managed app container. */
const CONTAINER_CREATION_SERVICES = [
  "app-creation-service.ts",
  "redeploy-service.ts",
  "github-deploy-service.ts"
];

describe("managedAppNetworkHostConfig", () => {
  test("attaches to the shared apps network with an empty DNS search list", () => {
    const hostConfig = managedAppNetworkHostConfig();

    assert.equal(hostConfig.NetworkMode, MANAGED_APPS_NETWORK);
    assert.equal(MANAGED_APPS_NETWORK, "deployment-apps");
    // "." is Docker's sentinel for "no search domain" (--dns-search=.).
    assert.deepEqual(hostConfig.DnsSearch, [CLEARED_DNS_SEARCH]);
    assert.deepEqual(hostConfig.DnsSearch, ["."]);
  });

  test("returns a fresh object so a caller cannot mutate shared state", () => {
    const first = managedAppNetworkHostConfig();
    first.DnsSearch.push("example.com");

    assert.deepEqual(managedAppNetworkHostConfig().DnsSearch, ["."]);
  });
});

describe("managed app networking stays in lockstep", () => {
  // The bug this guards: an app created one way and redeployed another silently
  // changes networking on the next deploy. Every creation path must go through
  // the one helper, so a container-name lookup behaves identically everywhere.
  for (const service of CONTAINER_CREATION_SERVICES) {
    test(`${service} builds its HostConfig from the shared helper`, () => {
      const source = readFileSync(join(SERVICES_DIR, service), "utf8");

      assert.ok(
        source.includes("...managedAppNetworkHostConfig()"),
        `${service} must spread managedAppNetworkHostConfig() into its HostConfig`
      );
      assert.ok(
        !/NetworkMode:\s*["']deployment-apps["']/.test(source),
        `${service} must not hardcode NetworkMode — it would skip the DNS search fix`
      );
    });
  }
});

describe("ensureManagedNameResolves", () => {
  /** A container attached to the managed network at `ip`, recording refreshes. */
  function makeOps(ip: string | undefined, opts: { ipAfterRefresh?: string } = {}) {
    const refreshes: string[] = [];
    let current = ip;
    return {
      refreshes,
      ops: {
        async inspectContainer(): Promise<{ networkAddresses?: Record<string, string> }> {
          return current ? { networkAddresses: { [MANAGED_APPS_NETWORK]: current } } : {};
        },
        async refreshNetworkEndpoint(containerId: string, networkName: string) {
          refreshes.push(`${containerId}:${networkName}`);
          if (opts.ipAfterRefresh) current = opts.ipAfterRefresh;
        }
      }
    };
  }

  test("leaves a healthy container completely alone", async () => {
    const { ops, refreshes } = makeOps("172.23.0.5");

    const result = await ensureManagedNameResolves({
      ops,
      containerId: "c1",
      containerName: "app-demo",
      resolveHostAddresses: async () => ["172.23.0.5"]
    });

    assert.deepEqual(result, { resolved: true, refreshed: false });
    assert.deepEqual(refreshes, [], "a resolvable name must never trigger an endpoint refresh");
  });

  test("REGRESSION: repairs a container whose name does not resolve (SERVFAIL)", async () => {
    // The observed fault: the container is attached with an IP and shows up in
    // `docker network inspect`, but a bare name lookup fails forever, so every
    // app->database connection dies with a DNS error.
    const { ops, refreshes } = makeOps("172.23.0.10");
    let lookups = 0;

    const result = await ensureManagedNameResolves({
      ops,
      containerId: "c1",
      containerName: "app-clovasuite-db",
      resolveHostAddresses: async () => {
        lookups += 1;
        if (lookups === 1) throw new Error("queryA ESERVFAIL app-clovasuite-db");
        return ["172.23.0.10"];
      }
    });

    assert.deepEqual(result, { resolved: true, refreshed: true });
    assert.deepEqual(refreshes, [`c1:${MANAGED_APPS_NETWORK}`]);
  });

  test("re-reads the IP after a refresh, since a reconnect can change it", async () => {
    const { ops } = makeOps("172.23.0.9", { ipAfterRefresh: "172.23.0.11" });

    const result = await ensureManagedNameResolves({
      ops,
      containerId: "c1",
      containerName: "app-demo",
      // Resolves only to the POST-refresh address.
      resolveHostAddresses: async () => ["172.23.0.11"]
    });

    assert.deepEqual(result, { resolved: true, refreshed: true });
  });

  test("never touches a container that is not on the managed network", async () => {
    const { ops, refreshes } = makeOps(undefined);

    const result = await ensureManagedNameResolves({
      ops,
      containerId: "c1",
      containerName: "app-demo",
      resolveHostAddresses: async () => {
        throw new Error("should not be consulted");
      }
    });

    assert.deepEqual(result, { resolved: false, refreshed: false });
    assert.deepEqual(refreshes, [], "must never force-attach a container");
  });

  test("is best-effort: a failing refresh never throws", async () => {
    const ops = {
      async inspectContainer() {
        return { networkAddresses: { [MANAGED_APPS_NETWORK]: "172.23.0.5" } };
      },
      async refreshNetworkEndpoint() {
        throw new Error("daemon refused the disconnect");
      }
    };

    const result = await ensureManagedNameResolves({
      ops,
      containerId: "c1",
      containerName: "app-demo",
      resolveHostAddresses: async () => {
        throw new Error("SERVFAIL");
      }
    });

    assert.deepEqual(result, { resolved: false, refreshed: false });
  });
});
