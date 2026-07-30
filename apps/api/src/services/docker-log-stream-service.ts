import type Docker from "dockerode";
import { extractLogFrames } from "./docker-logs-service.js";
import type { ManagedContainerFound } from "./managed-container-resolver.js";

export interface LogStreamOptions {
  /** Number of existing lines to replay before following new output. */
  tail: number;
  timestamps: boolean;
}

export interface LogStreamHandlers {
  onLine: (line: string) => void;
  /** Called exactly once, after any final flush, when the stream is finished. */
  onEnd: () => void;
  onError: (message: string) => void;
}

export interface AppLogStreamHandle {
  /** Stops following and releases the underlying Docker stream. Idempotent. */
  close: () => void;
}

/**
 * A single log line is capped at this many bytes so a container that
 * prints an unbounded amount without a newline can't grow the server's
 * pending buffer without limit.
 */
const MAX_LINE_BYTES = 16_384;

/** Splits an incoming text stream into complete lines, bounding the pending buffer. */
function createLineEmitter(emit: (line: string) => void) {
  let pending = "";

  return {
    push(text: string) {
      pending += text;

      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        let line = pending.slice(0, newlineIndex);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        emit(line);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }

      // A single very long line (no newline yet) is flushed in bounded
      // chunks rather than buffered indefinitely.
      while (pending.length > MAX_LINE_BYTES) {
        emit(pending.slice(0, MAX_LINE_BYTES));
        pending = pending.slice(MAX_LINE_BYTES);
      }
    },
    flush() {
      if (pending.length > 0) {
        emit(pending);
        pending = "";
      }
    }
  };
}

/**
 * Follows a managed app container's stdout/stderr in real time, decoding
 * Docker's multiplex framing (or treating the stream as raw text for TTY
 * containers) and emitting whole lines through `handlers.onLine`.
 *
 * The caller must have resolved `resolved` through `resolveManagedContainer`
 * first — this never accepts a raw container id, so it can't be aimed at an
 * unrelated or platform-owned container. It is strictly read-only.
 */
export async function streamAppLogs(
  docker: Docker,
  resolved: ManagedContainerFound,
  options: LogStreamOptions,
  handlers: LogStreamHandlers
): Promise<AppLogStreamHandle> {
  if (!resolved.containerExists || !resolved.containerId) {
    handlers.onError("The container for this app does not exist, so there is nothing to stream.");
    handlers.onEnd();
    return { close: () => {} };
  }

  const container = docker.getContainer(resolved.containerId);

  let tty = false;
  try {
    const info = await container.inspect();
    tty = info.Config?.Tty ?? false;
  } catch {
    handlers.onError("Unable to inspect the container to start the log stream.");
    handlers.onEnd();
    return { close: () => {} };
  }

  let logStream: NodeJS.ReadableStream & { destroy?: () => void };
  try {
    logStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: options.timestamps,
      tail: options.tail
    })) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
  } catch {
    handlers.onError("Unable to start the log stream.");
    handlers.onEnd();
    return { close: () => {} };
  }

  const stdoutEmitter = createLineEmitter(handlers.onLine);
  const stderrEmitter = createLineEmitter(handlers.onLine);
  let frameBuffer: Buffer = Buffer.alloc(0);
  let finished = false;

  function finish() {
    if (finished) {
      return;
    }
    finished = true;
    stdoutEmitter.flush();
    stderrEmitter.flush();
    handlers.onEnd();
  }

  logStream.on("data", (chunk: Buffer) => {
    if (tty) {
      stdoutEmitter.push(chunk.toString("utf8"));
      return;
    }

    frameBuffer = frameBuffer.length === 0 ? chunk : Buffer.concat([frameBuffer, chunk]);
    const { frames, rest } = extractLogFrames(frameBuffer);
    frameBuffer = rest;

    for (const frame of frames) {
      const emitter = frame.streamType === 2 ? stderrEmitter : stdoutEmitter;
      emitter.push(frame.payload.toString("utf8"));
    }

    // Defensive: if `rest` never resolves into a valid frame (a corrupt or
    // unexpectedly-unframed stream), don't accumulate forever — flush it as
    // raw text and reset.
    if (frameBuffer.length > MAX_LINE_BYTES) {
      stdoutEmitter.push(frameBuffer.toString("utf8"));
      frameBuffer = Buffer.alloc(0);
    }
  });

  logStream.on("end", finish);
  logStream.on("close", finish);
  logStream.on("error", () => {
    handlers.onError("The log stream ended unexpectedly.");
    finish();
  });

  return {
    close: () => {
      finished = true;
      logStream.destroy?.();
    }
  };
}
