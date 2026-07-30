import type Docker from "dockerode";
import type { ManagedContainerFound } from "./managed-container-resolver.js";

/** Docker's documented multiplex stream types: stdin, stdout, stderr. */
const VALID_STREAM_TYPES = new Set([0, 1, 2]);

export interface DockerLogFrame {
  streamType: number;
  payload: Buffer;
}

/**
 * Parses `buffer` as a sequence of Docker's 8-byte-framed multiplex chunks
 * (`[stream type, 0, 0, 0, big-endian length][payload]`), returning the
 * frames only if EVERY frame header is valid and the frames consume the
 * entire buffer with no leftover bytes. Returns `null` — never a partial
 * result — the moment any header fails validation (wrong stream type,
 * non-zero reserved bytes, a length that overruns the buffer) or a
 * trailing header/payload is incomplete. A caller seeing `null` should
 * treat the whole buffer as plain, unframed text — this is exactly the
 * case for containers created with a TTY, which never use multiplex
 * framing at all.
 */
export function parseDockerLogFrames(buffer: Buffer): DockerLogFrame[] | null {
  const frames: DockerLogFrame[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      // Incomplete trailing header.
      return null;
    }

    const streamType = buffer.readUInt8(offset);
    const reserved1 = buffer.readUInt8(offset + 1);
    const reserved2 = buffer.readUInt8(offset + 2);
    const reserved3 = buffer.readUInt8(offset + 3);

    if (!VALID_STREAM_TYPES.has(streamType) || reserved1 !== 0 || reserved2 !== 0 || reserved3 !== 0) {
      return null;
    }

    const payloadLength = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + payloadLength;

    if (payloadEnd > buffer.length) {
      // Incomplete trailing payload.
      return null;
    }

    frames.push({ streamType, payload: buffer.subarray(payloadStart, payloadEnd) });
    offset = payloadEnd;
  }

  return frames;
}

/**
 * Decodes a Docker logs buffer: valid multiplex framing is unwrapped to
 * its payload text; anything that doesn't validate as a complete,
 * fully-consumed sequence of frames (including a single malformed frame
 * partway through a long stream) falls back to decoding the ENTIRE buffer
 * as plain UTF-8 — deterministic, and never discards any bytes even though
 * it stops trying to interpret them as framed.
 */
export function decodeDockerLogs(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  const frames = parseDockerLogFrames(buffer);

  if (frames === null) {
    return buffer.toString("utf8");
  }

  return frames.map((frame) => frame.payload.toString("utf8")).join("");
}

export interface ExtractLogFramesResult {
  frames: DockerLogFrame[];
  /** Bytes after the last complete frame — an incomplete header/payload to carry into the next chunk. */
  rest: Buffer;
}

/**
 * Streaming counterpart to `parseDockerLogFrames`: pulls every *complete*
 * Docker multiplex frame from the front of `buffer` and returns whatever
 * trailing bytes form an incomplete header or payload as `rest`, so a
 * caller reading a live `docker logs --follow` stream can concatenate
 * `rest` with the next chunk and keep going without ever splitting a frame
 * across a chunk boundary.
 *
 * Unlike the whole-buffer parser this never returns null: it assumes the
 * caller has already established (from the container's TTY flag) that the
 * stream IS multiplexed. If it encounters a structurally invalid header
 * (bad stream type or non-zero reserved bytes) it stops there and hands
 * the remainder back as `rest`, leaving the caller to decide — this keeps
 * one corrupt byte from throwing on a long-lived stream.
 */
export function extractLogFrames(buffer: Buffer): ExtractLogFramesResult {
  const frames: DockerLogFrame[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      break;
    }

    const streamType = buffer.readUInt8(offset);
    const reserved1 = buffer.readUInt8(offset + 1);
    const reserved2 = buffer.readUInt8(offset + 2);
    const reserved3 = buffer.readUInt8(offset + 3);

    if (!VALID_STREAM_TYPES.has(streamType) || reserved1 !== 0 || reserved2 !== 0 || reserved3 !== 0) {
      break;
    }

    const payloadLength = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + payloadLength;

    if (payloadEnd > buffer.length) {
      // Payload not fully arrived yet — leave this header + partial payload in rest.
      break;
    }

    frames.push({ streamType, payload: buffer.subarray(payloadStart, payloadEnd) });
    offset = payloadEnd;
  }

  return { frames, rest: buffer.subarray(offset) };
}

export interface AppLogsRequestOptions {
  tail: number;
  since?: number;
  timestamps: boolean;
}

export interface AppLogsResult {
  appId: number;
  containerId: string | null;
  retrievedAt: string;
  lines: string[];
  truncated: boolean;
  containerRunning: boolean;
  error?: string;
}

/** Hard cap on decoded response size regardless of the requested tail. */
const MAX_RESPONSE_BYTES = 2_000_000;

function splitIntoLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (normalized.length === 0) {
    return [];
  }

  const lines = normalized.split("\n");

  // A trailing newline produces one trailing empty element from split() —
  // drop it so it doesn't render as a blank final log line.
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

/**
 * Bounds a raw Docker logs buffer to at most MAX_RESPONSE_BYTES of decoded
 * text, always preferring the newest content, and — critically — never
 * cutting through the middle of a Docker frame. For a valid multiplexed
 * stream, whole frames are kept starting from the newest (last) and
 * working backward until the cap would be exceeded; a single frame larger
 * than the entire cap is trimmed to its own newest bytes rather than
 * dropped outright. For plain (unframed) text, there's no frame boundary
 * to respect, so the newest raw bytes are kept directly, exactly as
 * before.
 */
function boundAndDecodeLogs(buffer: Buffer): { text: string; truncated: boolean } {
  if (buffer.length === 0) {
    return { text: "", truncated: false };
  }

  const frames = parseDockerLogFrames(buffer);

  if (frames === null) {
    const truncated = buffer.length > MAX_RESPONSE_BYTES;
    const bounded = truncated ? buffer.subarray(buffer.length - MAX_RESPONSE_BYTES) : buffer;
    return { text: bounded.toString("utf8"), truncated };
  }

  let totalBytes = 0;
  const kept: Buffer[] = [];
  let truncated = false;

  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const payload = frames[index].payload;

    if (totalBytes + payload.length <= MAX_RESPONSE_BYTES) {
      kept.unshift(payload);
      totalBytes += payload.length;
      continue;
    }

    if (kept.length === 0) {
      // The single newest frame alone exceeds the cap (one very large
      // line) — keep only its newest bytes rather than dropping it.
      const remaining = MAX_RESPONSE_BYTES - totalBytes;
      kept.unshift(payload.subarray(payload.length - remaining));
    }

    truncated = true;
    break;
  }

  const text = kept.map((payload) => payload.toString("utf8")).join("");
  return { text, truncated };
}

/**
 * Bounded, read-only log retrieval for exactly one managed app's
 * container. The caller must have already resolved `resolved` through
 * `resolveManagedContainer` — this function never accepts a raw container
 * id, so it can't be pointed at an unrelated or platform-owned container.
 */
export async function getAppLogs(
  docker: Docker,
  resolved: ManagedContainerFound,
  options: AppLogsRequestOptions
): Promise<AppLogsResult> {
  const retrievedAt = new Date().toISOString();

  if (!resolved.containerExists || !resolved.containerId) {
    return {
      appId: resolved.app.id,
      containerId: null,
      retrievedAt,
      lines: [],
      truncated: false,
      containerRunning: false
    };
  }

  try {
    const container = docker.getContainer(resolved.containerId);

    const raw = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: options.timestamps,
      tail: options.tail,
      since: options.since ?? 0
    });

    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as string);
    const { text, truncated } = boundAndDecodeLogs(buffer);

    return {
      appId: resolved.app.id,
      containerId: resolved.containerId,
      retrievedAt,
      lines: splitIntoLines(text),
      truncated,
      containerRunning: resolved.running
    };
  } catch {
    return {
      appId: resolved.app.id,
      containerId: resolved.containerId,
      retrievedAt,
      lines: [],
      truncated: false,
      containerRunning: resolved.running,
      error: "Unable to retrieve logs"
    };
  }
}
