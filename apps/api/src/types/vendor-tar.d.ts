// Minimal ambient declarations for the (untyped) tar-fs / tar-stream packages.
// Only the small surface this codebase uses is declared.

declare module "tar-fs" {
  import type { Readable } from "node:stream";

  interface PackOptions {
    /** Return true to EXCLUDE an absolute path from the archive. */
    ignore?: (name: string) => boolean;
    /** Explicit top-level entries to pack (relative to cwd). */
    entries?: string[];
  }

  export function pack(cwd: string, opts?: PackOptions): Readable;
}

declare module "tar-stream" {
  import type { Writable, Readable } from "node:stream";

  interface TarHeader {
    name: string;
    type?: string;
  }

  interface Extract extends Writable {
    on(
      event: "entry",
      listener: (header: TarHeader, stream: Readable, next: (err?: Error) => void) => void
    ): this;
    on(event: "finish", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
  }

  export function extract(): Extract;
}
