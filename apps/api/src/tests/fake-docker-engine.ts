import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { tarOf } from "./export-fakes.js";

/**
 * A minimal fake Docker ENGINE speaking the real HTTP API on localhost, so the real
 * dockerode-based export client can be exercised end to end (request shapes, the exec
 * hijack/upgrade handshake, multiplexed frames, 304 handling) with no daemon.
 *
 * It records every request. It is a TEST DOUBLE of the protocol surface the export
 * client uses — it does not reproduce Docker's behaviour beyond that.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface EngineContainer {
  id: string;
  name: string;
  running: boolean;
  paused?: boolean;
  exitCode?: number;
  image?: string;
  env?: string[];
  labels?: Record<string, string>;
  mounts?: Array<{ Type: string; Name?: string; Source?: string; Destination: string; RW?: boolean }>;
}

export function frame(type: 1 | 2, payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);

  return Buffer.concat([header, body]);
}

export class FakeDockerEngine {
  readonly requests: RecordedRequest[] = [];
  readonly containers = new Map<string, EngineContainer>();
  readonly volumes = new Set<string>();
  readonly images = new Map<string, { id: string; tar: Buffer }>();
  /** Volume name → tar served by the archive endpoint (a Readable, so large data streams). */
  readonly archives = new Map<string, () => Readable>();
  /** Container id/name → exec output frames and exit code. */
  readonly execs = new Map<string, { frames: Buffer[]; exitCode: number }>();
  /** Status code to answer with for a given "METHOD path" (e.g. to inject a 500 or 304). */
  readonly overrides = new Map<string, number>();
  /** Last created helper container body. */
  created: Array<{ id: string; body: Record<string, unknown> }> = [];
  helperLogs = Buffer.alloc(0);
  helperExitCode = 0;

  private server!: Server;
  private nextId = 1;

  /** Restart helper/exec id numbering, so tests can address `helper1` deterministically. */
  resetIds(): void {
    this.nextId = 1;
  }
  private execTargets = new Map<string, string>();
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("upgrade", (req, socket) => {
      const match = /\/exec\/([^/]+)\/start/.exec(req.url ?? "");
      const execId = match?.[1] ?? "";
      this.requests.push({ method: req.method ?? "", path: (req.url ?? "").split("?")[0]!, query: new URLSearchParams(), body: { upgrade: true } });
      const plan = this.execs.get(this.execTargets.get(execId) ?? "");

      socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      for (const piece of plan?.frames ?? []) {
        socket.write(piece);
      }
      socket.end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  calls(match: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => match.test(`${request.method} ${request.path}`));
  }

  private find(idOrName: string): EngineContainer | undefined {
    return this.containers.get(idOrName) ?? [...this.containers.values()].find((c) => c.name === idOrName || c.id === idOrName);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://engine");
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      /* not JSON */
    }
    this.requests.push({ method: req.method ?? "", path, query: url.searchParams, body });

    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const empty = (status: number): void => {
      res.writeHead(status);
      res.end();
    };
    const override = this.overrides.get(`${req.method} ${path}`);
    if (override !== undefined) {
      return override === 204 || override === 304 ? empty(override) : json(override, { message: `injected ${override}` });
    }

    let m: RegExpExecArray | null;

    if ((m = /^\/containers\/([^/]+)\/json$/.exec(path)) && req.method === "GET") {
      const c = this.find(decodeURIComponent(m[1]!));
      return c
        ? json(200, {
            Id: c.id,
            Name: `/${c.name}`,
            Config: { Image: c.image ?? "img", Env: c.env ?? [], Labels: c.labels ?? {} },
            State: { Status: c.running ? "running" : "exited", Running: c.running, Paused: c.paused ?? false, ExitCode: c.exitCode ?? 0, OOMKilled: false },
            HostConfig: { Privileged: false, NetworkMode: "deployment-apps", RestartPolicy: { Name: "unless-stopped" } },
            Mounts: c.mounts ?? []
          })
        : json(404, { message: "No such container" });
    }
    if ((m = /^\/containers\/([^/]+)\/(stop|start|pause|unpause|kill)$/.exec(path)) && req.method === "POST") {
      const c = this.find(decodeURIComponent(m[1]!));
      if (!c) {
        return json(404, { message: "No such container" });
      }
      const action = m[2];
      if (action === "stop") {
        if (!c.running) {
          return empty(304);
        }
        c.running = false;
      } else if (action === "start") {
        if (c.running) {
          return empty(304);
        }
        c.running = true;
      } else if (action === "pause") {
        c.paused = true;
      } else if (action === "unpause") {
        c.paused = false;
      }
      return empty(204);
    }
    if (path === "/containers/create" && req.method === "POST") {
      const id = `helper${this.nextId++}`;
      this.created.push({ id, body: body as Record<string, unknown> });
      this.containers.set(id, { id, name: id, running: false });
      return json(201, { Id: id, Warnings: [] });
    }
    if ((m = /^\/containers\/([^/]+)$/.exec(path)) && req.method === "DELETE") {
      const existed = this.containers.delete(decodeURIComponent(m[1]!));
      return existed ? empty(204) : json(404, { message: "No such container" });
    }
    if ((m = /^\/containers\/([^/]+)\/wait$/.exec(path)) && req.method === "POST") {
      return json(200, { StatusCode: this.helperExitCode });
    }
    if ((m = /^\/containers\/([^/]+)\/logs$/.exec(path)) && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
      return void res.end(this.helperLogs);
    }
    if ((m = /^\/containers\/([^/]+)\/archive$/.exec(path)) && req.method === "GET") {
      const id = decodeURIComponent(m[1]!);
      const created = this.created.find((c) => c.id === id);
      const bind = ((created?.body.HostConfig as { Binds?: string[] } | undefined)?.Binds ?? [])[0] ?? "";
      const volume = bind.split(":")[0] ?? "";
      const make = this.archives.get(volume);
      if (!make) {
        return json(404, { message: "no such path" });
      }
      res.writeHead(200, { "Content-Type": "application/x-tar" });
      return void make().pipe(res);
    }
    if (path === "/containers/json" && req.method === "GET") {
      const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as { label?: string[] };
      const wanted = filters.label ?? [];
      const listed = [...this.containers.values()].filter((c) => wanted.every((label) => {
        const [k, v] = label.split("=");
        return (c.labels ?? this.created.find((x) => x.id === c.id)?.body.Labels as Record<string, string> | undefined)?.[k!] === v;
      }));
      return json(200, listed.map((c) => ({ Id: c.id, Names: [`/${c.name}`] })));
    }
    if ((m = /^\/containers\/([^/]+)\/exec$/.exec(path)) && req.method === "POST") {
      const target = this.find(decodeURIComponent(m[1]!));
      if (!target) {
        return json(404, { message: "No such container" });
      }
      const execId = `exec${this.nextId++}`;
      this.execTargets.set(execId, target.name);
      return json(201, { Id: execId });
    }
    if ((m = /^\/exec\/([^/]+)\/json$/.exec(path)) && req.method === "GET") {
      const plan = this.execs.get(this.execTargets.get(m[1]!) ?? "");
      return json(200, { ExitCode: plan?.exitCode ?? 0, Running: false });
    }
    if ((m = /^\/volumes\/([^/]+)$/.exec(path)) && req.method === "GET") {
      const name = decodeURIComponent(m[1]!);
      return this.volumes.has(name) ? json(200, { Name: name }) : json(404, { message: "get volume: no such volume" });
    }
    if ((m = /^\/images\/(.+)\/get$/.exec(path)) && req.method === "GET") {
      const image = this.images.get(decodeURIComponent(m[1]!));
      if (!image) {
        return json(404, { message: "No such image" });
      }
      res.writeHead(200, { "Content-Type": "application/x-tar" });
      return void res.end(image.tar);
    }
    if ((m = /^\/images\/(.+)\/json$/.exec(path)) && req.method === "GET") {
      const image = this.images.get(decodeURIComponent(m[1]!));
      return image ? json(200, { Id: image.id, RepoTags: [decodeURIComponent(m[1]!)] }) : json(404, { message: "No such image" });
    }

    json(404, { message: `fake engine: unhandled ${req.method} ${path}` });
  }
}

export const emptyTar = (): Buffer => tarOf({});
