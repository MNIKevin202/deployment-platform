import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import type Docker from "dockerode";
import { getErrorStatusCode } from "../docker-errors.js";

/**
 * Read-only access to the Docker daemon for migration preflight.
 *
 * The read-only guarantee is enforced by the TYPE SYSTEM, not by discipline:
 * preflight code receives a `ReadOnlyDockerProbe`, which is built from a
 * `ReadOnlyDockerClient` — a structural type that lists ONLY query methods. There
 * is no way to express `start`, `stop`, `createContainer`, `exec`, `pull`,
 * `remove` or `prune` through it. A real `dockerode` instance is assignable to the
 * client type, and tests pass a recording fake to prove only these calls happen.
 */

/** The only dockerode operations preflight may use. */
export interface ReadOnlyDockerClient {
  info(): Promise<unknown>;
  version(): Promise<unknown>;
  listContainers(options: { all: boolean }): Promise<unknown[]>;
  getContainer(id: string): { inspect(): Promise<unknown> };
  listVolumes(): Promise<{ Volumes?: unknown[] | null }>;
  listImages(): Promise<unknown[]>;
  getImage(name: string): { inspect(): Promise<unknown> };
  df(): Promise<unknown>;
}

/**
 * Wraps a real dockerode instance so that ONLY the query methods are reachable.
 * The wrapper holds the dockerode object privately; callers receive no reference
 * to it, so even a cast cannot reach `start`, `stop` or `createContainer`.
 */
export function readOnlyClientFrom(docker: Docker): ReadOnlyDockerClient {
  return {
    info: () => docker.info(),
    version: () => docker.version(),
    listContainers: (options) => docker.listContainers(options),
    getContainer: (id) => {
      const container = docker.getContainer(id);

      return { inspect: () => container.inspect() };
    },
    listVolumes: () => docker.listVolumes(),
    listImages: () => docker.listImages(),
    getImage: (name) => {
      const image = docker.getImage(name);

      return { inspect: () => image.inspect() };
    },
    df: () => docker.df()
  };
}

export interface DockerHostInfo {
  /** Stable per Docker installation. */
  daemonId: string;
  hostname: string;
  dockerVersion: string;
  apiVersion: string;
  operatingSystem: string;
  osType: string;
  /** Normalised: "x64" | "arm64" | other. */
  arch: string;
  kernelVersion: string;
  memTotalBytes: number;
  cpuCount: number;
  dockerRootDir: string;
}

export interface MountInfo {
  type: string;
  name: string | null;
  source: string | null;
  destination: string;
  readWrite: boolean;
}

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  labels: Record<string, string>;
  mounts: MountInfo[];
  publishedPorts: Array<{ hostPort: number; protocol: string }>;
}

export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  exitCode: number | null;
  oomKilled: boolean;
  privileged: boolean;
  networkMode: string;
  restartPolicy: string;
  labels: Record<string, string>;
  mounts: MountInfo[];
  networks: string[];
  publishedPorts: Array<{ hostPort: number; containerPort: number; protocol: string }>;
}

export interface VolumeSummary {
  name: string;
  driver: string;
  labels: Record<string, string>;
}

export interface ImageSummary {
  id: string;
  tags: string[];
  sizeBytes: number;
}

export interface ImageDetail extends ImageSummary {
  architecture: string;
  os: string;
}

export interface DiskUsage {
  /** Size in bytes by volume name; null when the daemon could not compute it. */
  volumeSizes: Map<string, number | null>;
  imageSizes: Map<string, number>;
}

export interface ReadOnlyDockerProbe {
  info(): Promise<DockerHostInfo>;
  listContainers(): Promise<ContainerSummary[]>;
  inspectContainer(nameOrId: string): Promise<ContainerDetail | null>;
  listVolumes(): Promise<VolumeSummary[]>;
  listImages(): Promise<ImageSummary[]>;
  inspectImage(reference: string): Promise<ImageDetail | null>;
  diskUsage(): Promise<DiskUsage>;
}

// ----------------------------------------------------------- normalisation ----

type Raw = Record<string, unknown>;

const asRaw = (value: unknown): Raw => (typeof value === "object" && value !== null ? (value as Raw) : {});
const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const asNumber = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function asLabels(value: unknown): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const [key, entry] of Object.entries(asRaw(value))) {
    if (typeof entry === "string") {
      labels[key] = entry;
    }
  }

  return labels;
}

export function normalizeArch(arch: string): string {
  switch (arch.toLowerCase()) {
    case "x86_64":
    case "amd64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return arch.toLowerCase() || "unknown";
  }
}

function stripSlash(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

function mountOf(raw: unknown): MountInfo {
  const mount = asRaw(raw);

  return {
    type: asString(mount.Type, "unknown"),
    name: typeof mount.Name === "string" ? mount.Name : null,
    source: typeof mount.Source === "string" ? mount.Source : null,
    destination: asString(mount.Destination),
    readWrite: mount.RW !== false
  };
}

export function normalizeInfo(info: unknown, version: unknown): DockerHostInfo {
  const i = asRaw(info);
  const v = asRaw(version);

  return {
    daemonId: asString(i.ID),
    hostname: asString(i.Name),
    dockerVersion: asString(v.Version, asString(i.ServerVersion)),
    apiVersion: asString(v.ApiVersion),
    operatingSystem: asString(i.OperatingSystem),
    osType: asString(i.OSType),
    arch: normalizeArch(asString(i.Architecture, asString(v.Arch))),
    kernelVersion: asString(i.KernelVersion),
    memTotalBytes: asNumber(i.MemTotal),
    cpuCount: asNumber(i.NCPU),
    dockerRootDir: asString(i.DockerRootDir)
  };
}

export function normalizeContainerSummary(raw: unknown): ContainerSummary {
  const c = asRaw(raw);

  return {
    id: asString(c.Id),
    name: stripSlash(asString(asArray(c.Names)[0])),
    image: asString(c.Image),
    state: asString(c.State),
    labels: asLabels(c.Labels),
    mounts: asArray(c.Mounts).map(mountOf),
    publishedPorts: asArray(c.Ports)
      .map(asRaw)
      .filter((port) => typeof port.PublicPort === "number")
      .map((port) => ({ hostPort: asNumber(port.PublicPort), protocol: asString(port.Type, "tcp") }))
  };
}

export function normalizeContainerDetail(raw: unknown): ContainerDetail {
  const c = asRaw(raw);
  const state = asRaw(c.State);
  const config = asRaw(c.Config);
  const host = asRaw(c.HostConfig);
  const bindings = asRaw(host.PortBindings);
  const publishedPorts: ContainerDetail["publishedPorts"] = [];

  for (const [key, entries] of Object.entries(bindings)) {
    const [portText, protocol = "tcp"] = key.split("/");
    for (const entry of asArray(entries)) {
      const hostPort = Number.parseInt(asString(asRaw(entry).HostPort), 10);
      if (Number.isFinite(hostPort)) {
        publishedPorts.push({ hostPort, containerPort: Number.parseInt(portText ?? "0", 10), protocol });
      }
    }
  }

  return {
    id: asString(c.Id),
    name: stripSlash(asString(c.Name)),
    image: asString(config.Image),
    status: asString(state.Status),
    running: state.Running === true,
    exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
    oomKilled: state.OOMKilled === true,
    privileged: host.Privileged === true,
    networkMode: asString(host.NetworkMode),
    restartPolicy: asString(asRaw(host.RestartPolicy).Name),
    labels: asLabels(config.Labels),
    mounts: asArray(c.Mounts).map(mountOf),
    networks: Object.keys(asRaw(asRaw(c.NetworkSettings).Networks)),
    publishedPorts
  };
}

export function normalizeImage(raw: unknown): ImageSummary {
  const image = asRaw(raw);

  return {
    id: asString(image.Id),
    tags: asArray(image.RepoTags).filter((tag): tag is string => typeof tag === "string" && tag !== "<none>:<none>"),
    sizeBytes: asNumber(image.Size)
  };
}

export function normalizeDiskUsage(raw: unknown): DiskUsage {
  const df = asRaw(raw);
  const volumeSizes = new Map<string, number | null>();
  const imageSizes = new Map<string, number>();

  for (const entry of asArray(df.Volumes).map(asRaw)) {
    const size = asNumber(asRaw(entry.UsageData).Size, -1);
    volumeSizes.set(asString(entry.Name), size >= 0 ? size : null);
  }
  for (const entry of asArray(df.Images).map(asRaw)) {
    for (const tag of asArray(entry.RepoTags)) {
      if (typeof tag === "string") {
        imageSizes.set(tag, asNumber(entry.Size));
      }
    }
  }

  return { volumeSizes, imageSizes };
}

// -------------------------------------------------------------- real probe ----

export function createDockerProbe(client: ReadOnlyDockerClient): ReadOnlyDockerProbe {
  const notFound = (error: unknown): boolean => getErrorStatusCode(error) === 404;

  return {
    async info() {
      const [info, version] = await Promise.all([client.info(), client.version()]);

      return normalizeInfo(info, version);
    },

    async listContainers() {
      return (await client.listContainers({ all: true })).map(normalizeContainerSummary);
    },

    async inspectContainer(nameOrId) {
      try {
        return normalizeContainerDetail(await client.getContainer(nameOrId).inspect());
      } catch (error) {
        if (notFound(error)) {
          return null;
        }
        throw error;
      }
    },

    async listVolumes() {
      const result = await client.listVolumes();

      return asArray(result.Volumes).map((raw) => {
        const volume = asRaw(raw);

        return { name: asString(volume.Name), driver: asString(volume.Driver), labels: asLabels(volume.Labels) };
      });
    },

    async listImages() {
      return (await client.listImages()).map(normalizeImage);
    },

    async inspectImage(reference) {
      try {
        const raw = asRaw(await client.getImage(reference).inspect());

        return { ...normalizeImage(raw), architecture: normalizeArch(asString(raw.Architecture)), os: asString(raw.Os) };
      } catch (error) {
        if (notFound(error)) {
          return null;
        }
        throw error;
      }
    },

    async diskUsage() {
      return normalizeDiskUsage(await client.df());
    }
  };
}

// --------------------------------------------------------------- host facts ----

export interface HostFacts {
  /** Stable, privacy-preserving id derived from the Docker daemon id. */
  serverId: string;
  hostname: string;
  arch: string;
  osDescription: string;
  dockerVersion: string;
  memTotalBytes: number;
  cpuCount: number;
  /** Free bytes on the filesystem holding the path that was inspected, if known. */
  freeDiskBytes: number | null;
  totalDiskBytes: number | null;
  diskPath: string | null;
}

/** serverId = a one-way hash of the Docker daemon id, so the raw id is never exposed. */
export function deriveServerId(daemonId: string, fallback: string): string {
  const basis = daemonId || fallback;

  return `srv-${createHash("sha256").update(`cfmig-server-id\0${basis}`).digest("hex").slice(0, 16)}`;
}

export function diskSpaceAt(path: string): { free: number; total: number } | null {
  try {
    const stats = statfsSync(path);

    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
  } catch {
    return null;
  }
}

export function collectHostFacts(info: DockerHostInfo, diskPath: string | null): HostFacts {
  const disk = diskPath ? diskSpaceAt(diskPath) : null;

  return {
    serverId: deriveServerId(info.daemonId, info.hostname),
    hostname: info.hostname,
    arch: info.arch,
    osDescription: info.operatingSystem,
    dockerVersion: info.dockerVersion,
    memTotalBytes: info.memTotalBytes,
    cpuCount: info.cpuCount,
    freeDiskBytes: disk?.free ?? null,
    totalDiskBytes: disk?.total ?? null,
    diskPath: disk ? diskPath : null
  };
}
