import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createUpdateTriggerBridge } from "../services/update-trigger-bridge.js";

// The bridge is a POSIX Unix-domain-socket client; a listening AF_UNIX server is
// not permitted under this Windows dev shell (EACCES). These run on Linux (CI +
// production, the only place the bridge actually exists). Unix domain socket
// paths also have a length limit; keep the temp path short.
const SKIP_UNIX = process.platform === "win32";

describe("update-trigger bridge client", () => {
  let dir: string;
  let sockPath: string;
  let server: net.Server | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-trig-"));
    sockPath = join(dir, "t.sock");
    server = null;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("connecting fires exactly one trigger and sends NO payload", { skip: SKIP_UNIX }, async () => {
    let connections = 0;
    let bytesReceived = 0;
    server = net.createServer((socket) => {
      connections += 1;
      socket.on("data", (chunk) => {
        bytesReceived += chunk.length;
      });
    });
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));

    const trigger = createUpdateTriggerBridge(sockPath, 2000);
    await trigger();
    // Give the server a tick to observe any (unexpected) bytes.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(connections, 1, "exactly one connection = one trigger");
    assert.equal(bytesReceived, 0, "the client must send no payload (connecting is the whole signal)");
  });

  test("each call triggers exactly once (no duplicate connections)", { skip: SKIP_UNIX }, async () => {
    let connections = 0;
    server = net.createServer(() => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));

    const trigger = createUpdateTriggerBridge(sockPath, 2000);
    await trigger();
    await trigger();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(connections, 2);
  });

  test("an unavailable socket rejects cleanly (no throw escapes, no side effects)", { skip: SKIP_UNIX }, async () => {
    // No server listening at this path.
    const trigger = createUpdateTriggerBridge(join(dir, "does-not-exist.sock"), 1000);
    await assert.rejects(trigger(), /ENOENT|connect/i);
  });
});
