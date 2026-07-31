import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildPublishedPortConfig, isValidPort } from "../services/port-bindings.js";

describe("isValidPort", () => {
  test("accepts ports in 1..65535", () => {
    assert.equal(isValidPort(1), true);
    assert.equal(isValidPort(25565), true);
    assert.equal(isValidPort(65535), true);
  });

  test("rejects out-of-range and non-integer ports", () => {
    assert.equal(isValidPort(0), false);
    assert.equal(isValidPort(65536), false);
    assert.equal(isValidPort(-5), false);
    assert.equal(isValidPort(80.5), false);
    assert.equal(isValidPort(Number.NaN), false);
  });
});

describe("buildPublishedPortConfig", () => {
  test("maps ports to Docker ExposedPorts + PortBindings", () => {
    const config = buildPublishedPortConfig([
      { hostPort: 25565, containerPort: 25565, protocol: "tcp" },
      { hostPort: 19132, containerPort: 19132, protocol: "udp" }
    ]);

    assert.deepEqual(config.ExposedPorts, {
      "25565/tcp": {},
      "19132/udp": {}
    });
    assert.deepEqual(config.PortBindings, {
      "25565/tcp": [{ HostPort: "25565" }],
      "19132/udp": [{ HostPort: "19132" }]
    });
  });

  test("supports mapping a container port to a different host port", () => {
    const config = buildPublishedPortConfig([
      { hostPort: 8443, containerPort: 443, protocol: "tcp" }
    ]);

    assert.deepEqual(config.ExposedPorts, { "443/tcp": {} });
    assert.deepEqual(config.PortBindings, { "443/tcp": [{ HostPort: "8443" }] });
  });

  test("returns empty maps for no ports (unchanged container config)", () => {
    const config = buildPublishedPortConfig([]);
    assert.deepEqual(config.ExposedPorts, {});
    assert.deepEqual(config.PortBindings, {});
  });
});
