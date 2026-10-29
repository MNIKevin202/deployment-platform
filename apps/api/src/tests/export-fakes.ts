import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import type {
  ArchiveStream,
  ExecStream,
  ExportContainerInfo,
  ExportDockerClient,
  HelperRunOptions
} from "../migration/export-docker.js";

/**
 * A fake Docker daemon for EXPORT tests, with deliberate fault injection.
 *
 * Containers, volumes (as lazily generated tar streams), images, exec scripts and
 * helper containers are all simulated. Every call is recorded. Faults can make any
 * operation fail, make a stream die after N bytes, or make a stream stall forever.
 * With `statePath` the container states live in a file, so a SEPARATE PROCESS can
 * observe what a killed exporter left behind. Nothing here touches a real daemon.
 */

// ---------------------------------------------------------------- tar writer ----

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function tarHeader(name: string, size: number, type: "0" | "5" = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(type === "5" ? 0o755 : 0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(1_700_000_000, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

  return header;
}

export interface TarEntry {
  name: string;
  size: number;
  /** Produces the `index`-th chunk of at most `max` bytes of this entry's data. */
  chunk(index: number, max: number): Buffer;
}

export function bufferEntry(name: string, data: Buffer): TarEntry {
  return { name, size: data.length, chunk: (index, max) => data.subarray(index * max, (index + 1) * max) };
}

/** A big file whose content is derived from its position, so nothing is ever held in memory. */
export function syntheticEntry(name: string, size: number, seed = 1): TarEntry {
  return {
    name,
    size,
    chunk(index, max) {
      const start = index * max;
      const length = Math.min(max, size - start);
      if (length <= 0) {
        return Buffer.alloc(0);
      }
      const hash = createHash("sha256").update(`${seed}:${index}`).digest();
      const out = Buffer.alloc(length);
      for (let offset = 0; offset < length; offset += hash.length) {
        hash.copy(out, offset, 0, Math.min(hash.length, length - offset));
      }

      return out;
    }
  };
}

/**
 * A big file of INCOMPRESSIBLE, deterministic data (AES-CTR keystream), so tests can check
 * both that streaming never buffers it and that it round-trips bit-for-bit.
 */
export function incompressibleEntry(name: string, size: number, seed = 1): TarEntry {
  const key = createHash("sha256").update(`key:${seed}`).digest().subarray(0, 16);

  return {
    name,
    size,
    chunk(index, max) {
      const length = Math.min(max, size - index * max);
      if (length <= 0) {
        return Buffer.alloc(0);
      }
      const iv = Buffer.alloc(16);
      iv.writeUInt32BE(index, 12);

      return createCipheriv("aes-128-ctr", key, iv).update(Buffer.alloc(length));
    }
  };
}

const CHUNK = 64 * 1024;

/** Lazily streams a tar of the given entries. */
export function lazyTar(entries: TarEntry[], options: { failAfterBytes?: number; stallAfterBytes?: number; error?: Error } = {}): Readable {
  let sent = 0;

  // A SYNCHRONOUS generator driven by a hand-written Readable: a stalled stream is simply one that
  // stops pushing, so destroy() works at once — as it does on a real socket. (An async generator
  // blocked on a never-settling promise cannot be interrupted, which would hang the test, not the code.)
  function* chunks(): Generator<Buffer> {
    for (const entry of entries) {
      yield tarHeader(entry.name, entry.size);
      for (let index = 0; index * CHUNK < entry.size; index += 1) {
        yield entry.chunk(index, CHUNK);
      }
      const pad = (512 - (entry.size % 512)) % 512;
      if (pad > 0) {
        yield Buffer.alloc(pad);
      }
    }
    yield Buffer.alloc(1024);
  }
  const iterator = chunks();

  return new Readable({
    read() {
      for (;;) {
        const next = iterator.next();
        if (next.done) {
          this.push(null);
          return;
        }
        if (options.stallAfterBytes !== undefined && sent >= options.stallAfterBytes) {
          return; // a hung read: nothing more will ever arrive
        }
        if (options.failAfterBytes !== undefined && sent + next.value.length > options.failAfterBytes) {
          this.destroy(options.error ?? new Error("injected stream failure"));
          return;
        }
        sent += next.value.length;
        if (!this.push(next.value)) {
          return;
        }
      }
    }
  });
}

export function tarOf(files: Record<string, Buffer | string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of Object.entries(files)) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    parts.push(tarHeader(name, buffer.length), buffer, Buffer.alloc((512 - (buffer.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));

  return Buffer.concat(parts);
}

/** Lists the entries of a (small) tar buffer: name → data. */
export function untar(buffer: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    files[name] = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return files;
}

// ------------------------------------------------------------------ the fake ----

export interface FakeContainerSpec {
  name: string;
  image?: string;
  running?: boolean;
  /** Exit code recorded when the container is stopped. 0 = clean, 137 = killed. */
  exitCodeOnStop?: number;
  oomKilled?: boolean;
  env?: Record<string, string>;
  mounts?: Array<{ type: "volume" | "bind"; name?: string; source?: string; destination: string }>;
  restartPolicy?: string;
}

interface ContainerState {
  spec: Required<Pick<FakeContainerSpec, "name" | "image" | "exitCodeOnStop" | "oomKilled" | "restartPolicy">> & FakeContainerSpec;
  running: boolean;
  paused: boolean;
  exitCode: number | null;
}

export type FaultOp = "inspect" | "stop" | "start" | "pause" | "unpause" | "exec" | "volumeArchive" | "runHelper" | "imageSave" | "dispose";

export interface Fault {
  op: FaultOp;
  /** Container / volume / image name this applies to; omitted = any. */
  target?: string;
  error?: Error;
  /** Fail the first N matching calls then succeed (default: every call). */
  times?: number;
  /** Skip this many matching calls before starting to fail. */
  after?: number;
}

export interface ExecScript {
  /** Called with the full command; returns what the command "prints". */
  (cmd: string[]): { stdout: Buffer | Readable; exitCode?: number; stderr?: string; failAfterBytes?: number; stallAfterBytes?: number };
}

export class FakeExportDocker implements ExportDockerClient {
  readonly calls: string[] = [];
  readonly faults: Fault[] = [];
  readonly volumes = new Map<string, TarEntry[]>();
  readonly images = new Map<string, Buffer>();
  readonly execScripts = new Map<string, ExecScript>();
  readonly helperScripts: Array<(options: HelperRunOptions) => { exitCode: number; stdout: string } | null> = [];
  /** Volume name → stream fault. */
  readonly volumeFaults = new Map<string, { failAfterBytes?: number; stallAfterBytes?: number; error?: Error }>();
  helpersOpen = 0;
  helpersCreated = 0;
  /** Invoked before every call; tests use it to interleave actions or throw. */
  onCall?: (op: FaultOp, target: string) => void | Promise<void>;

  private readonly containers = new Map<string, ContainerState>();
  private readonly counts = new Map<string, number>();

  constructor(private readonly statePath?: string) {
    if (statePath && existsSync(statePath)) {
      const saved = JSON.parse(readFileSync(statePath, "utf8")) as Array<ContainerState>;
      for (const state of saved) {
        this.containers.set(state.spec.name, state);
      }
    }
  }

  addContainer(spec: FakeContainerSpec): this {
    this.containers.set(spec.name, {
      spec: { image: "app:latest", exitCodeOnStop: 0, oomKilled: false, restartPolicy: "unless-stopped", ...spec },
      running: spec.running ?? true,
      paused: false,
      exitCode: null
    });
    this.persist();

    return this;
  }

  addVolume(name: string, entries: TarEntry[]): this {
    this.volumes.set(name, entries);

    return this;
  }

  state(name: string): { running: boolean; paused: boolean; exitCode: number | null } {
    const container = this.containers.get(name);
    if (!container) {
      throw new Error(`no such fake container ${name}`);
    }

    return { running: container.running, paused: container.paused, exitCode: container.exitCode };
  }

  /** Re-reads the on-disk state (for a different process's view). */
  reload(): void {
    if (this.statePath && existsSync(this.statePath)) {
      this.containers.clear();
      for (const state of JSON.parse(readFileSync(this.statePath, "utf8")) as Array<ContainerState>) {
        this.containers.set(state.spec.name, state);
      }
    }
  }

  private persist(): void {
    if (this.statePath) {
      writeFileSync(this.statePath, JSON.stringify([...this.containers.values()]));
    }
  }

  private async enter(op: FaultOp, target: string): Promise<void> {
    this.calls.push(`${op}:${target}`);
    await this.onCall?.(op, target);

    for (const fault of this.faults) {
      if (fault.op !== op || (fault.target !== undefined && fault.target !== target)) {
        continue;
      }
      const key = `${op}:${target}:${this.faults.indexOf(fault)}`;
      const seen = this.counts.get(key) ?? 0;
      this.counts.set(key, seen + 1);
      if (seen < (fault.after ?? 0)) {
        continue;
      }
      if (fault.times !== undefined && seen - (fault.after ?? 0) >= fault.times) {
        continue;
      }
      throw fault.error ?? new Error(`injected ${op} failure on ${target}`);
    }
  }

  private get(nameOrId: string): ContainerState | undefined {
    return this.containers.get(nameOrId) ?? [...this.containers.values()].find((c) => `id-${c.spec.name}` === nameOrId);
  }

  async inspectContainer(nameOrId: string): Promise<ExportContainerInfo | null> {
    await this.enter("inspect", nameOrId);
    const c = this.get(nameOrId);
    if (!c) {
      return null;
    }

    return {
      id: `id-${c.spec.name}`,
      name: c.spec.name,
      image: c.spec.image,
      status: c.paused ? "paused" : c.running ? "running" : "exited",
      running: c.running && !c.paused ? true : c.running,
      paused: c.paused,
      exitCode: c.exitCode,
      oomKilled: c.spec.oomKilled && !c.running,
      restartPolicy: c.spec.restartPolicy,
      privileged: false,
      networkMode: "deployment-apps",
      mounts: (c.spec.mounts ?? []).map((m) => ({
        type: m.type,
        name: m.name ?? null,
        source: m.source ?? null,
        destination: m.destination,
        readWrite: true
      })),
      env: c.spec.env ?? {}
    };
  }

  async stopContainer(id: string): Promise<void> {
    await this.enter("stop", id);
    const c = this.get(id);
    if (!c) {
      throw new Error("no such container");
    }
    if (c.running) {
      c.running = false;
      c.paused = false;
      c.exitCode = c.spec.exitCodeOnStop;
      this.persist();
    }
  }

  async startContainer(id: string): Promise<void> {
    await this.enter("start", id);
    const c = this.get(id);
    if (!c) {
      throw new Error("no such container");
    }
    c.running = true;
    c.paused = false;
    this.persist();
  }

  async pauseContainer(id: string): Promise<void> {
    await this.enter("pause", id);
    const c = this.get(id);
    if (!c || !c.running) {
      throw new Error("container is not running");
    }
    c.paused = true;
    this.persist();
  }

  async unpauseContainer(id: string): Promise<void> {
    await this.enter("unpause", id);
    const c = this.get(id);
    if (!c) {
      throw new Error("no such container");
    }
    c.paused = false;
    this.persist();
  }

  async exec(id: string, cmd: string[]): Promise<ExecStream> {
    await this.enter("exec", id);
    const c = this.get(id);
    if (!c || !c.running) {
      throw new Error("container is not running");
    }
    const script = this.execScripts.get(c.spec.name);
    if (!script) {
      throw new Error(`no fake exec script for ${c.spec.name}`);
    }
    const result = script(cmd);
    const stdout = new PassThrough();
    const source = Buffer.isBuffer(result.stdout) ? Readable.from([result.stdout]) : result.stdout;
    let sent = 0;
    source.on("data", (chunk: Buffer) => {
      if (result.stallAfterBytes !== undefined && sent >= result.stallAfterBytes) {
        source.pause();
        return;
      }
      if (result.failAfterBytes !== undefined && sent + chunk.length > result.failAfterBytes) {
        source.destroy();
        stdout.destroy(new Error("injected exec stream failure"));
        return;
      }
      sent += chunk.length;
      if (!stdout.write(chunk)) {
        source.pause();
        stdout.once("drain", () => source.resume());
      }
    });
    source.on("end", () => stdout.end());

    // Registered NOW, not inside finished(): the stream will usually have ended before finished() is called.
    const ended = new Promise<void>((resolve) => {
      stdout.on("end", resolve);
      stdout.on("error", () => resolve());
      stdout.on("close", resolve);
    });

    return {
      stdout,
      finished: async () => {
        await ended;

        return { exitCode: result.exitCode ?? 0, stderr: result.stderr ?? "" };
      }
    };
  }

  async volumeArchive(volumeName: string): Promise<ArchiveStream> {
    await this.enter("volumeArchive", volumeName);
    const entries = this.volumes.get(volumeName);
    if (!entries) {
      throw new Error(`Volume "${volumeName}" does not exist; refusing to create it.`);
    }

    this.helpersOpen += 1;
    this.helpersCreated += 1;
    let disposed = false;

    return {
      stream: lazyTar(entries, this.volumeFaults.get(volumeName)),
      dispose: async () => {
        if (disposed) {
          return;
        }
        await this.enter("dispose", volumeName);
        disposed = true; // only once the removal worked, so a failed attempt can be retried
        this.helpersOpen -= 1;
      }
    };
  }

  async runHelper(options: HelperRunOptions): Promise<{ exitCode: number; stdout: string }> {
    await this.enter("runHelper", options.entrypoint.join(" "));
    for (const script of this.helperScripts) {
      const result = script(options);
      if (result) {
        return result;
      }
    }

    return { exitCode: 127, stdout: "" };
  }

  async imageSave(reference: string): Promise<Readable> {
    await this.enter("imageSave", reference);
    const image = this.images.get(reference);
    if (!image) {
      throw new Error(`No such image: ${reference}`);
    }

    return Readable.from([image]);
  }

  async imageId(reference: string): Promise<string | null> {
    const image = this.images.get(reference);

    return image ? `sha256:${createHash("sha256").update(image).digest("hex")}` : null;
  }

  async sweepHelpers(): Promise<number> {
    const open = this.helpersOpen;
    this.helpersOpen = 0;

    return open;
  }
}

export function randomPayload(bytes: number): Buffer {
  return randomBytes(bytes);
}
