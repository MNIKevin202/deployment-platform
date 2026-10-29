import { Readable, Transform, Writable, addAbortSignal, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream";
import { createGzip } from "node:zlib";

/**
 * Stream building blocks for export. Every one of these is bounded-memory: nothing
 * here accumulates a whole volume, image or dump. Large data only ever moves as a
 * pipeline of backpressure-respecting streams.
 */

/** Counts bytes passing through, untouched. */
export class ByteCounter extends Transform {
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

/**
 * Passes data through while remembering only the LAST `tailBytes` bytes and the
 * total length. Used to verify a dump's trailer line without buffering the dump.
 */
export class TailCapture extends Transform {
  bytes = 0;
  private tail: Buffer = Buffer.alloc(0);

  constructor(private readonly tailBytes: number = 4096) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > this.tailBytes) {
      this.tail = this.tail.subarray(this.tail.length - this.tailBytes);
    }
    callback(null, chunk);
  }

  tailText(): string {
    return this.tail.toString("utf8");
  }
}

/** A Writable that keeps at most `limit` bytes (for stderr snippets); the rest is counted and dropped. */
export class LimitedCollector extends Writable {
  private chunks: Buffer[] = [];
  private kept = 0;
  dropped = 0;

  constructor(private readonly limit: number = 64 * 1024) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const room = this.limit - this.kept;
    if (room > 0) {
      const slice = chunk.subarray(0, room);
      this.chunks.push(slice);
      this.kept += slice.length;
      this.dropped += chunk.length - slice.length;
    } else {
      this.dropped += chunk.length;
    }
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Demultiplexes Docker's attach/exec stream (8-byte frame header: type, 3 zero
 * bytes, big-endian length) into a stdout stream and a stderr sink — WITH
 * backpressure. `modem.demuxStream` writes without ever pausing, so a slow
 * consumer would make a large dump pile up in memory; this does not.
 */
export class DockerFrameDemux extends Writable {
  private pending: Buffer = Buffer.alloc(0);

  constructor(
    private readonly stdout: Writable,
    private readonly onStderr: (chunk: Buffer) => void
  ) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    const drain = (): void => {
      while (this.pending.length >= 8) {
        const size = this.pending.readUInt32BE(4);
        if (size > MAX_FRAME_BYTES) {
          callback(new Error("Docker stream frame is implausibly large; the stream is corrupt."));
          return;
        }
        if (this.pending.length < 8 + size) {
          break;
        }

        const type = this.pending[0];
        const payload = this.pending.subarray(8, 8 + size);
        this.pending = this.pending.subarray(8 + size);

        if (type === 1) {
          if (!this.stdout.write(payload)) {
            this.stdout.once("drain", drain);
            return;
          }
        } else if (type === 2) {
          this.onStderr(payload);
        }
      }
      callback();
    };

    drain();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.pending.length > 0) {
      callback(new Error("Docker stream ended inside a frame; the output is truncated."));
      return;
    }
    this.stdout.end();
    callback();
  }
}

/** Parses a fully buffered Docker multiplexed log (small helper-container output only). */
export function demuxBuffer(buffer: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const payload = buffer.subarray(offset + 8, offset + 8 + size);
    (buffer[offset] === 2 ? err : out).push(payload);
    offset += 8 + size;
  }

  return { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

/**
 * Builds `source → [counter] → gzip` as ONE readable. If any stage fails (or the
 * signal aborts) every stage is destroyed and the error reaches whoever consumes
 * the result, so a failed volume read can never be mistaken for a short archive.
 */
export function compressed(
  source: Readable,
  options: { level: number; signal?: AbortSignal; counter?: ByteCounter }
): Readable {
  const input = options.signal ? addAbortSignal(options.signal, source) : source;
  const counter = options.counter ?? new ByteCounter();
  const gzip = createGzip({ level: options.level });

  pipeline(input, counter, gzip, (error) => {
    if (error) {
      gzip.destroy(error);
    }
  });

  return gzip;
}

/** Same, without compression (images are already compressed layers). */
export function counted(source: Readable, options: { signal?: AbortSignal; counter: ByteCounter }): Readable {
  const input = options.signal ? addAbortSignal(options.signal, source) : source;

  pipeline(input, options.counter, (error) => {
    if (error) {
      options.counter.destroy(error);
    }
  });

  return options.counter;
}

/** Adapts Docker's `NodeJS.ReadableStream` to a real `Readable`. */
export function asReadable(stream: NodeJS.ReadableStream): Readable {
  return stream instanceof Readable ? stream : new Readable().wrap(stream);
}
