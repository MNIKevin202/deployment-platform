import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  CLEARED_DNS_SEARCH,
  MANAGED_APPS_NETWORK,
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
