import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { suggestAvailablePort } from "../routes/ports.js";

describe("suggestAvailablePort", () => {
  test("returns a port in the friendly range when nothing is used", () => {
    const port = suggestAvailablePort(new Set(), () => 0);
    assert.equal(port, 3000);
  });

  test("never returns a port that is already in use", () => {
    const used = new Set([3000, 3001, 3002]);
    // First random hits 3000 (used); the second lands elsewhere.
    const sequence = [0, 0.5];
    let i = 0;
    const port = suggestAvailablePort(used, () => sequence[i++ % sequence.length]);
    assert.ok(!used.has(port));
    assert.ok(port >= 3000 && port <= 9999);
  });

  test("falls back to scanning when the whole friendly range is taken", () => {
    const used = new Set<number>();
    for (let p = 3000; p <= 9999; p += 1) {
      used.add(p);
    }
    // random always points at the (used) friendly range, forcing the scan.
    const port = suggestAvailablePort(used, () => 0);
    assert.equal(port, 1024);
  });

  test("scan skips used low ports", () => {
    const used = new Set<number>();
    for (let p = 3000; p <= 9999; p += 1) {
      used.add(p);
    }
    used.add(1024);
    used.add(1025);
    const port = suggestAvailablePort(used, () => 0);
    assert.equal(port, 1026);
  });
});
