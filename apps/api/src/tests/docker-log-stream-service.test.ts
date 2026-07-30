import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { extractLogFrames } from "../services/docker-logs-service.js";
import { streamAppLogs } from "../services/docker-log-stream-service.js";
import type { ManagedContainerFound } from "../services/managed-container-resolver.js";

/** Builds one Docker multiplex frame: [type,0,0,0, big-endian len][payload]. */
function frame(streamType: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function foundContainer(overrides: Partial<ManagedContainerFound> = {}): ManagedContainerFound {
  return {
    found: true,
    app: { id: 1 } as ManagedContainerFound["app"],
    containerExists: true,
    running: true,
    containerId: "cid",
    ...overrides
  };
}

function fakeDocker(stream: PassThrough, tty: boolean) {
  return {
    getContainer() {
      return {
        async inspect() {
          return { Config: { Tty: tty } };
        },
        async logs() {
          return stream;
        }
      };
    }
  } as unknown as Parameters<typeof streamAppLogs>[0];
}

interface Collected {
  lines: string[];
  notices: string[];
  ended: Promise<void>;
}

function collect(): { handlers: Parameters<typeof streamAppLogs>[3]; result: Collected } {
  const lines: string[] = [];
  const notices: string[] = [];
  let resolveEnd!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });

  return {
    handlers: {
      onLine: (line) => lines.push(line),
      onError: (message) => notices.push(message),
      onEnd: () => resolveEnd()
    },
    result: { lines, notices, ended }
  };
}

describe("extractLogFrames (streaming, chunk-boundary-safe)", () => {
  test("pulls complete frames and returns partial trailing bytes as rest", () => {
    const full = Buffer.concat([frame(1, "one\n"), frame(1, "two\n")]);
    // Split partway through the second frame's payload.
    const cut = full.length - 2;
    const first = extractLogFrames(full.subarray(0, cut));
    assert.equal(first.frames.length, 1);
    assert.equal(first.frames[0].payload.toString(), "one\n");
    assert.ok(first.rest.length > 0);

    // Feeding rest + the remainder yields the second frame.
    const second = extractLogFrames(Buffer.concat([first.rest, full.subarray(cut)]));
    assert.equal(second.frames.length, 1);
    assert.equal(second.frames[0].payload.toString(), "two\n");
    assert.equal(second.rest.length, 0);
  });
});

describe("streamAppLogs", () => {
  test("decodes multiplexed frames into lines across chunk boundaries", async () => {
    const stream = new PassThrough();
    const { handlers, result } = collect();

    const handle = await streamAppLogs(
      fakeDocker(stream, false),
      foundContainer(),
      { tail: 100, timestamps: false },
      handlers
    );

    // A frame whose payload has one complete and one partial line...
    stream.write(frame(1, "hello\nwor"));
    // ...completed by a later frame, plus a stderr line.
    stream.write(frame(1, "ld\n"));
    stream.write(frame(2, "oops\n"));
    stream.end();

    await result.ended;
    handle.close();

    assert.deepEqual(result.lines, ["hello", "world", "oops"]);
  });

  test("splits a single frame delivered in two raw chunks", async () => {
    const stream = new PassThrough();
    const { handlers, result } = collect();

    await streamAppLogs(fakeDocker(stream, false), foundContainer(), { tail: 100, timestamps: false }, handlers);

    const whole = frame(1, "split-line\n");
    stream.write(whole.subarray(0, 6)); // partial header+payload
    stream.write(whole.subarray(6));
    stream.end();

    await result.ended;
    assert.deepEqual(result.lines, ["split-line"]);
  });

  test("treats a TTY stream as raw, unframed text", async () => {
    const stream = new PassThrough();
    const { handlers, result } = collect();

    await streamAppLogs(fakeDocker(stream, true), foundContainer(), { tail: 100, timestamps: false }, handlers);

    stream.write(Buffer.from("alpha\nbeta\n", "utf8"));
    stream.end();

    await result.ended;
    assert.deepEqual(result.lines, ["alpha", "beta"]);
  });

  test("flushes a trailing line with no newline on end", async () => {
    const stream = new PassThrough();
    const { handlers, result } = collect();

    await streamAppLogs(fakeDocker(stream, false), foundContainer(), { tail: 100, timestamps: false }, handlers);

    stream.write(frame(1, "no-newline-tail"));
    stream.end();

    await result.ended;
    assert.deepEqual(result.lines, ["no-newline-tail"]);
  });

  test("reports a notice and ends when the container does not exist", async () => {
    const stream = new PassThrough();
    const { handlers, result } = collect();

    const handle = await streamAppLogs(
      fakeDocker(stream, false),
      foundContainer({ containerExists: false, containerId: null }),
      { tail: 100, timestamps: false },
      handlers
    );

    await result.ended;
    assert.equal(result.lines.length, 0);
    assert.equal(result.notices.length, 1);
    assert.match(result.notices[0], /does not exist/);
    // close() is safe to call even though nothing was streamed.
    handle.close();
  });
});
