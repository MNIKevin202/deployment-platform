import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeDockerLogs, getAppLogs, parseDockerLogFrames } from "../services/docker-logs-service.js";
import type { ManagedContainerFound } from "../services/managed-container-resolver.js";
import type { StoredApp } from "../database.js";

function frameLogLine(streamType: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function fakeApp(overrides: Partial<StoredApp> = {}): StoredApp {
  return {
    id: 1,
    name: "app-one",
    containerId: "container-1",
    containerName: "app-app-one",
    image: "nginx:alpine",
    containerPort: 80,
    domain: null,
    internalOnly: false,
    status: "running",
    desiredStatus: "running",
    restartPolicy: "unless-stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployedAt: null,
    environmentTouchedAt: null,
    memoryLimitMb: null,
    cpuLimit: null,
    ...overrides
  };
}

function resolvedRunning(overrides: Partial<ManagedContainerFound> = {}): ManagedContainerFound {
  return {
    found: true,
    app: fakeApp(),
    containerExists: true,
    running: true,
    containerId: "container-1",
    ...overrides
  };
}

describe("decodeDockerLogs", () => {
  test("decodes multiplexed frames (stdout + stderr) back-to-back", () => {
    const buffer = Buffer.concat([
      frameLogLine(1, "stdout line\n"),
      frameLogLine(2, "stderr line\n")
    ]);

    assert.equal(decodeDockerLogs(buffer), "stdout line\nstderr line\n");
  });

  test("falls back to plain UTF-8 for non-framed (TTY) output", () => {
    const buffer = Buffer.from("hello world\n", "utf8");
    assert.equal(decodeDockerLogs(buffer), "hello world\n");
  });

  test("does not corrupt framing bytes into visible text", () => {
    const buffer = frameLogLine(1, "clean output only\n");
    const decoded = decodeDockerLogs(buffer);
    assert.equal(decoded, "clean output only\n");
    // The one stray control byte (the stream-type byte) never survives into output.
    assert.equal(decoded.length, "clean output only\n".length);
  });

  test("handles an empty buffer without throwing", () => {
    assert.equal(decodeDockerLogs(Buffer.alloc(0)), "");
  });
});

describe("parseDockerLogFrames", () => {
  test("parses a single stdout frame", () => {
    const frames = parseDockerLogFrames(frameLogLine(1, "stdout\n"));
    assert.equal(frames?.length, 1);
    assert.equal(frames?.[0].streamType, 1);
    assert.equal(frames?.[0].payload.toString("utf8"), "stdout\n");
  });

  test("parses a single stderr frame", () => {
    const frames = parseDockerLogFrames(frameLogLine(2, "stderr\n"));
    assert.equal(frames?.length, 1);
    assert.equal(frames?.[0].streamType, 2);
  });

  test("parses multiple valid frames in order", () => {
    const buffer = Buffer.concat([
      frameLogLine(1, "a\n"),
      frameLogLine(2, "b\n"),
      frameLogLine(1, "c\n")
    ]);

    const frames = parseDockerLogFrames(buffer);
    assert.equal(frames?.length, 3);
    assert.deepEqual(
      frames?.map((f) => f.payload.toString("utf8")),
      ["a\n", "b\n", "c\n"]
    );
  });

  test("parses a zero-length frame", () => {
    const frames = parseDockerLogFrames(frameLogLine(1, ""));
    assert.equal(frames?.length, 1);
    assert.equal(frames?.[0].payload.length, 0);
  });

  test("rejects a frame with a malformed stream type", () => {
    const buffer = frameLogLine(1, "ok\n");
    buffer.writeUInt8(3, 0); // 3 is not a valid Docker stream type
    assert.equal(parseDockerLogFrames(buffer), null);
  });

  test("rejects a frame with non-zero reserved bytes", () => {
    const buffer = frameLogLine(1, "ok\n");
    buffer.writeUInt8(1, 1); // reserved byte at offset 1 must be zero
    assert.equal(parseDockerLogFrames(buffer), null);
  });

  test("rejects an incomplete final header", () => {
    // A full valid frame followed by 3 stray bytes — short of a full 8-byte header.
    const buffer = Buffer.concat([frameLogLine(1, "ok\n"), Buffer.from([1, 0, 0])]);
    assert.equal(parseDockerLogFrames(buffer), null);
  });

  test("rejects an incomplete final payload", () => {
    const full = frameLogLine(1, "hello world\n");
    // The header claims 12 bytes of payload but only 9 are actually present.
    const buffer = full.subarray(0, full.length - 3);
    assert.equal(parseDockerLogFrames(buffer), null);
  });

  test("rejects plain text longer than eight bytes with no frame structure", () => {
    const buffer = Buffer.from("this is a long line of plain text output\n", "utf8");
    assert.equal(parseDockerLogFrames(buffer), null);
  });

  test("does not misclassify plain text whose bytes 4-7 happen to form a plausible small length", () => {
    // Byte 0 is 'h' (104), which is not a valid Docker stream type (0/1/2),
    // so this must be rejected regardless of what bytes 4-7 look like.
    const text = "hello world, this line is deliberately long\n";
    const buffer = Buffer.from(text, "utf8");

    assert.equal(parseDockerLogFrames(buffer), null);
    assert.equal(decodeDockerLogs(buffer), text);
  });

  test("a well-formed frame followed by malformed data falls back to plain text for the whole buffer, not a partial decode", () => {
    const validFrame = frameLogLine(1, "first line\n");
    const garbage = Buffer.from("not a valid second frame at all, plain junk\n", "utf8");
    const buffer = Buffer.concat([validFrame, garbage]);

    assert.equal(parseDockerLogFrames(buffer), null);

    const decoded = decodeDockerLogs(buffer);
    // Every byte in this fixture is ASCII, so a lossless plain-text decode
    // re-encodes to exactly the original byte length — nothing was
    // silently discarded because one later frame failed validation.
    assert.equal(Buffer.byteLength(decoded, "utf8"), buffer.length);
  });
});

interface FakeLogsOptions {
  stdout?: boolean;
  stderr?: boolean;
  timestamps?: boolean;
  tail?: number;
  since?: number;
}

function createFakeDocker(handler: (options: FakeLogsOptions) => Promise<Buffer>) {
  return {
    getContainer: () => ({
      logs: handler
    })
  } as unknown as import("dockerode");
}

describe("getAppLogs", () => {
  test("returns a clear stopped-container state without calling Docker logs", async () => {
    let called = false;
    const docker = createFakeDocker(async () => {
      called = true;
      return Buffer.alloc(0);
    });

    const resolved = resolvedRunning({ containerExists: false, running: false, containerId: null });

    const result = await getAppLogs(docker, resolved, { tail: 200, timestamps: true });

    assert.equal(result.containerRunning, false);
    assert.equal(result.containerId, null);
    assert.deepEqual(result.lines, []);
    assert.equal(called, false);
  });

  test("decodes plain stdout output into lines", async () => {
    const docker = createFakeDocker(async () => frameLogLine(1, "line one\nline two\n"));

    const resolved = resolvedRunning();
    const result = await getAppLogs(docker, resolved, { tail: 200, timestamps: true });

    assert.deepEqual(result.lines, ["line one", "line two"]);
    assert.equal(result.containerRunning, true);
    assert.equal(result.containerId, "container-1");
  });

  test("normalizes CRLF and lone CR line endings to LF", async () => {
    const docker = createFakeDocker(async () => frameLogLine(1, "a\r\nb\rc\n"));

    const resolved = resolvedRunning();
    const result = await getAppLogs(docker, resolved, { tail: 200, timestamps: true });

    assert.deepEqual(result.lines, ["a", "b", "c"]);
  });

  test("passes tail/since/timestamps through to the Docker logs call", async () => {
    let received: FakeLogsOptions = {};
    const docker = createFakeDocker(async (options) => {
      received = options;
      return frameLogLine(1, "ok\n");
    });

    const resolved = resolvedRunning();
    await getAppLogs(docker, resolved, { tail: 500, since: 1700000000, timestamps: false });

    assert.equal(received.tail, 500);
    assert.equal(received.since, 1700000000);
    assert.equal(received.timestamps, false);
  });

  test("bounds and truncates an unexpectedly large response", async () => {
    const hugePayload = "a".repeat(3_000_000);
    const docker = createFakeDocker(async () => frameLogLine(1, hugePayload));

    const resolved = resolvedRunning();
    const result = await getAppLogs(docker, resolved, { tail: 2000, timestamps: true });

    assert.equal(result.truncated, true);
  });

  test("truncated is false for a response comfortably below the cap", async () => {
    const docker = createFakeDocker(async () => frameLogLine(1, "small\n"));
    const resolved = resolvedRunning();
    const result = await getAppLogs(docker, resolved, { tail: 200, timestamps: true });

    assert.equal(result.truncated, false);
  });

  test("truncates many small multiplexed frames at a frame boundary — never mid-frame — and keeps the newest lines", async () => {
    const frameCount = 5000;
    const frames: Buffer[] = [];

    for (let i = 0; i < frameCount; i += 1) {
      frames.push(frameLogLine(1, `line-${i}-${"x".repeat(400)}\n`));
    }

    const buffer = Buffer.concat(frames);
    // Sanity check: this fixture must actually exceed the cap, or the test
    // wouldn't be exercising truncation at all.
    assert.ok(buffer.length > 2_000_000);

    const docker = createFakeDocker(async () => buffer);
    const resolved = resolvedRunning();
    const result = await getAppLogs(docker, resolved, { tail: frameCount, timestamps: false });

    assert.equal(result.truncated, true);
    assert.ok(result.lines.length > 0);

    // No Docker frame header bytes (control characters) leak into any
    // returned line — truncation never began partway through a frame.
    for (const line of result.lines) {
      for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
        const code = line.charCodeAt(charIndex);
        assert.ok(
          code >= 0x20,
          `line contains an unexpected control character (possible leaked frame header): ${JSON.stringify(line)}`
        );
      }
    }

    // The newest content is retained...
    const lastLine = result.lines[result.lines.length - 1];
    assert.match(lastLine, new RegExp(`^line-${frameCount - 1}-`));

    // ...and the oldest lines were dropped to make room, not corrupted.
    assert.ok(!result.lines.some((line) => line.startsWith("line-0-")));
  });

  test("truncates plain (unframed) text safely, retaining the newest bytes", async () => {
    const bigText = "y".repeat(3_000_000);
    const docker = createFakeDocker(async () => Buffer.from(bigText, "utf8"));

    const resolved = resolvedRunning();
    const result = await getAppLogs(docker, resolved, { tail: 2000, timestamps: true });

    assert.equal(result.truncated, true);
    const joined = result.lines.join("\n");
    assert.ok(joined.length > 0);
    assert.ok(joined.length <= 2_000_000);
    // Every retained character is still part of the original repeated
    // character, confirming the retained slice truly came from the buffer
    // rather than being corrupted.
    assert.ok(/^y+$/.test(joined));
  });

  test("returns an error field rather than throwing when Docker fails", async () => {
    const docker = createFakeDocker(async () => {
      throw new Error("Docker daemon unreachable");
    });

    const resolved = resolvedRunning();
    const result = await getAppLogs(docker, resolved, { tail: 200, timestamps: true });

    assert.equal(result.error, "Unable to retrieve logs");
    assert.deepEqual(result.lines, []);
  });

  test("returns an empty-state result for a container with no log output", async () => {
    const docker = createFakeDocker(async () => Buffer.alloc(0));

    const resolved = resolvedRunning();
    const result = await getAppLogs(docker, resolved, { tail: 200, timestamps: true });

    assert.deepEqual(result.lines, []);
    assert.equal(result.error, undefined);
  });
});
