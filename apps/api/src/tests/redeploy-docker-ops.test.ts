import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type Docker from "dockerode";
import { createDockerOps } from "../services/redeploy-service.js";

describe("createDockerOps.refreshNetworkEndpoint", () => {
  test("disconnects then reconnects the exact container id on the given network, copying no EndpointConfig", async () => {
    const ops: string[] = [];
    let disconnectArg: Record<string, unknown> | undefined;
    let connectArg: Record<string, unknown> | undefined;

    const fakeDocker = {
      getNetwork(name: string) {
        ops.push(`getNetwork:${name}`);
        return {
          async disconnect(opts: Record<string, unknown>) {
            ops.push("disconnect");
            disconnectArg = opts;
          },
          async connect(opts: Record<string, unknown>) {
            ops.push("connect");
            connectArg = opts;
          }
        };
      }
    } as unknown as Docker;

    await createDockerOps(fakeDocker).refreshNetworkEndpoint("cid-123", "deployment-apps");

    // Ordering: resolve the network once, then disconnect BEFORE connect.
    assert.deepEqual(ops, ["getNetwork:deployment-apps", "disconnect", "connect"]);

    // Both operations target the exact container id, by id.
    assert.deepEqual(disconnectArg, { Container: "cid-123" });
    assert.equal(connectArg?.Container, "cid-123");

    // Crucially, reconnect supplies NO EndpointConfig — Docker rebuilds the
    // container's own default DNSNames; nothing is copied from any other
    // container (e.g. Caddy).
    assert.equal("EndpointConfig" in (connectArg ?? {}), false);
  });
});
