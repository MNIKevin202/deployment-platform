import { PassThrough, Readable } from "node:stream";
import type Docker from "dockerode";
import { getErrorStatusCode } from "../docker-errors.js";
import type { MountInfo } from "./probes.js";
import { DockerFrameDemux, LimitedCollector, asReadable, demuxBuffer } from "./streams.js";

/**
 * The Docker operations EXPORT needs — and nothing more.
 *
 * This is deliberately separate from the Phase-0 read-only probe. Export must
 * disturb a running app in exactly two ways (stop or pause it, for a consistent
 * snapshot) and must undo that afterwards, so this client can stop/start/pause/
 * unpause containers and run short-lived, network-less, read-only HELPER
 * containers. It cannot create volumes or networks, load or import images, write
 * into a container, or connect anything: there is no import or restore verb in it.
 * Those arrive in later phases, in a different module, behind their own approval.
 *
 * Every helper container is labelled so a crashed export's leftovers can be swept.
 */

export const LABEL_MIGRATION_TOOL = "com.deployment-platform.migration-tool";
export const HELPER_LABEL_VALUE = "export-helper";

export interface ExportContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  paused: boolean;
  exitCode: number | null;
  oomKilled: boolean;
  restartPolicy: string;
  privileged: boolean;
  networkMode: string;
  mounts: MountInfo[];
  /**
   * Environment as KEY→VALUE. Used ONLY to read non-secret settings (e.g. PGDATA).
   * Values may be secret and must never be copied into a report or the manifest.
   */
  env: Record<string, string>;
}

export interface ExecStream {
  /** The command's stdout, as a bounded-memory stream with backpressure. */
  stdout: Readable;
  /** Resolves when the command has finished: its exit code and a capped stderr snippet. */
  finished(): Promise<{ exitCode: number; stderr: string }>;
}

export interface ArchiveStream {
  /** A tar stream of the volume's contents. */
  stream: Readable;
  /** Removes the helper container. Safe to call more than once; call it after the stream ends or fails. */
  dispose(): Promise<void>;
}

export interface HelperRunOptions {
  image: string;
  entrypoint: string[];
  cmd: string[];
  /** Docker bind specs; callers must make them read-only (":ro"). */
  binds: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExportDockerClient {
  inspectContainer(nameOrId: string): Promise<ExportContainerInfo | null>;
  stopContainer(id: string, graceSeconds: number): Promise<void>;
  startContainer(id: string): Promise<void>;
  pauseContainer(id: string): Promise<void>;
  unpauseContainer(id: string): Promise<void>;
  exec(id: string, cmd: string[], options?: { user?: string; signal?: AbortSignal }): Promise<ExecStream>;
  volumeArchive(volumeName: string, options: { helperImage: string; signal?: AbortSignal }): Promise<ArchiveStream>;
  runHelper(options: HelperRunOptions): Promise<{ exitCode: number; stdout: string }>;
  imageSave(reference: string): Promise<Readable>;
  /** The image's content id (sha256:…), or null if it does not exist locally. */
  imageId(reference: string): Promise<string | null>;
  /** Removes leftover helper containers from earlier exports. Returns how many. */
  sweepHelpers(): Promise<number>;
}

// ----------------------------------------------------------------- parsing ----

type Raw = Record<string, unknown>;
const asRaw = (value: unknown): Raw => (typeof value === "object" && value !== null ? (value as Raw) : {});
const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

export function parseExportContainer(raw: unknown): ExportContainerInfo {
  const c = asRaw(raw);
  const state = asRaw(c.State);
  const config = asRaw(c.Config);
  const host = asRaw(c.HostConfig);
  const env: Record<string, string> = {};

  for (const entry of Array.isArray(config.Env) ? config.Env : []) {
    if (typeof entry === "string") {
      const index = entry.indexOf("=");
      if (index > 0) {
        env[entry.slice(0, index)] = entry.slice(index + 1);
      }
    }
  }

  return {
    id: asString(c.Id),
    name: asString(c.Name).replace(/^\//, ""),
    image: asString(config.Image),
    status: asString(state.Status),
    running: state.Running === true,
    paused: state.Paused === true,
    exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
    oomKilled: state.OOMKilled === true,
    restartPolicy: asString(asRaw(host.RestartPolicy).Name),
    privileged: host.Privileged === true,
    networkMode: asString(host.NetworkMode),
    mounts: (Array.isArray(c.Mounts) ? c.Mounts : []).map((entry) => {
      const mount = asRaw(entry);

      return {
        type: asString(mount.Type, "unknown"),
        name: typeof mount.Name === "string" ? mount.Name : null,
        source: typeof mount.Source === "string" ? mount.Source : null,
        destination: asString(mount.Destination),
        readWrite: mount.RW !== false
      };
    }),
    env
  };
}

// -------------------------------------------------------------- real client ----

const STDERR_LIMIT = 64 * 1024;
const HELPER_OUTPUT_LIMIT = 1024 * 1024;

/** Docker answers 304 when asked to do something already done. That is success for us. */
const alreadyDone = (error: unknown): boolean => getErrorStatusCode(error) === 304;
const missing = (error: unknown): boolean => getErrorStatusCode(error) === 404;

export function createExportDockerClient(docker: Docker): ExportDockerClient {
  const helperLabels = (): Record<string, string> => ({ [LABEL_MIGRATION_TOOL]: HELPER_LABEL_VALUE });

  async function removeQuietly(container: { remove(options: { force: boolean; v: boolean }): Promise<unknown> }): Promise<void> {
    try {
      // v:false — never remove volumes. (Named volumes survive anyway; this is belt and braces.)
      await container.remove({ force: true, v: false });
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }

  return {
    async inspectContainer(nameOrId) {
      try {
        return parseExportContainer(await docker.getContainer(nameOrId).inspect());
      } catch (error) {
        if (missing(error)) {
          return null;
        }
        throw error;
      }
    },

    async stopContainer(id, graceSeconds) {
      try {
        await docker.getContainer(id).stop({ t: graceSeconds });
      } catch (error) {
        if (!alreadyDone(error)) {
          throw error;
        }
      }
    },

    async startContainer(id) {
      try {
        await docker.getContainer(id).start();
      } catch (error) {
        if (!alreadyDone(error)) {
          throw error;
        }
      }
    },

    async pauseContainer(id) {
      await docker.getContainer(id).pause();
    },

    async unpauseContainer(id) {
      await docker.getContainer(id).unpause();
    },

    async exec(id, cmd, options = {}) {
      const container = docker.getContainer(id);
      const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        ...(options.user ? { User: options.user } : {})
      });
      const raw = asReadable(await exec.start({ hijack: true, stdin: false, Tty: false }));
      const stdout = new PassThrough();
      const stderr = new LimitedCollector(STDERR_LIMIT);
      const demux = new DockerFrameDemux(stdout, (chunk) => stderr.write(chunk));

      let streamEnded: Promise<void>;
      const fail = (error: Error): void => {
        stdout.destroy(error);
        raw.destroy();
      };

      streamEnded = new Promise<void>((resolve) => {
        demux.on("finish", resolve);
        demux.on("error", (error) => {
          fail(error);
          resolve();
        });
        raw.on("error", (error) => {
          fail(error);
          resolve();
        });
        raw.on("close", resolve);
      });
      raw.pipe(demux);

      options.signal?.addEventListener("abort", () => fail(new Error("The export was cancelled.")), { once: true });

      return {
        stdout,
        async finished() {
          await streamEnded;
          // The exit code is recorded a moment after the stream closes.
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const inspected = await exec.inspect();
            if (inspected.Running !== true && typeof inspected.ExitCode === "number") {
              return { exitCode: inspected.ExitCode, stderr: stderr.text() };
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          return { exitCode: -1, stderr: stderr.text() };
        }
      };
    },

    async volumeArchive(volumeName, options) {
      // Binding a volume that does not exist makes Docker CREATE it. Never let that happen.
      try {
        await docker.getVolume(volumeName).inspect();
      } catch (error) {
        throw missing(error) ? new Error(`Volume "${volumeName}" does not exist; refusing to create it.`) : error;
      }

      const container = await docker.createContainer({
        Image: options.helperImage,
        Cmd: ["true"],
        Labels: helperLabels(),
        NetworkDisabled: true,
        HostConfig: {
          Binds: [`${volumeName}:/src:ro`],
          ReadonlyRootfs: true,
          NetworkMode: "none",
          AutoRemove: false
        }
      });

      // Marked done only AFTER the removal succeeds, so a failed attempt can be retried.
      let disposed = false;
      const dispose = async (): Promise<void> => {
        if (!disposed) {
          await removeQuietly(container);
          disposed = true;
        }
      };

      try {
        // The container is never STARTED: the daemon serves the archive from its mounts.
        const stream = asReadable(await container.getArchive({ path: "/src/." }));
        options.signal?.addEventListener("abort", () => stream.destroy(new Error("The export was cancelled.")), { once: true });

        return { stream, dispose };
      } catch (error) {
        await dispose();
        throw error;
      }
    },

    async runHelper(options) {
      const container = await docker.createContainer({
        Image: options.image,
        Entrypoint: options.entrypoint,
        Cmd: options.cmd,
        Labels: helperLabels(),
        NetworkDisabled: true,
        HostConfig: { Binds: options.binds, ReadonlyRootfs: true, NetworkMode: "none", AutoRemove: false }
      });

      try {
        await container.start();

        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          container.wait().then((result: { StatusCode: number }) => ({ exitCode: result.StatusCode, timedOut: false })),
          new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => {
            timer = setTimeout(() => resolve({ exitCode: -1, timedOut: true }), options.timeoutMs);
            options.signal?.addEventListener("abort", () => resolve({ exitCode: -1, timedOut: true }), { once: true });
          })
        ]);
        if (timer) {
          clearTimeout(timer);
        }
        if (outcome.timedOut) {
          await container.kill().catch(() => undefined);
          throw new Error("A helper container did not finish in time.");
        }

        const logs = (await container.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
        const text = demuxBuffer(Buffer.isBuffer(logs) ? logs.subarray(0, HELPER_OUTPUT_LIMIT) : Buffer.from(String(logs)));

        return { exitCode: outcome.exitCode, stdout: text.stdout };
      } finally {
        await removeQuietly(container);
      }
    },

    async imageSave(reference) {
      return asReadable(await docker.getImage(reference).get());
    },

    async imageId(reference) {
      try {
        const id = asRaw(await docker.getImage(reference).inspect()).Id;

        return typeof id === "string" ? id : null;
      } catch (error) {
        if (missing(error)) {
          return null;
        }
        throw error;
      }
    },

    async sweepHelpers() {
      const found = await docker.listContainers({
        all: true,
        filters: { label: [`${LABEL_MIGRATION_TOOL}=${HELPER_LABEL_VALUE}`] }
      });
      let removed = 0;

      for (const entry of found) {
        const id = asString(asRaw(entry).Id);
        if (id) {
          await removeQuietly(docker.getContainer(id));
          removed += 1;
        }
      }

      return removed;
    }
  };
}
