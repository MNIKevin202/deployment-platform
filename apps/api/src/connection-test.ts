import net from "node:net";
import { resolveSrv as dnsResolveSrv } from "node:dns/promises";

/**
 * Testing a stored connection string end-to-end would mean bundling a client
 * driver for every database kind (Mongo, Postgres, MySQL, Redis, …) and
 * performing a full authenticated handshake. Instead this does a *reachability*
 * probe: parse the host out of the string (resolving an Atlas `+srv` record via
 * DNS when needed), then open a plain TCP connection to it. That surfaces the
 * common real problems — a typo'd cluster host, a DNS failure, a firewall/IP
 * allowlist blocking us — without any driver dependency. It deliberately does
 * NOT check the username or password; the message says so.
 */

export interface ConnectionTarget {
  scheme: string;
  baseScheme: string;
  host: string;
  port: number | null;
  isSrv: boolean;
}

const DEFAULT_PORTS: Record<string, number> = {
  mongodb: 27017,
  postgres: 5432,
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  rediss: 6379
};

const PROBE_TIMEOUT_MS = 5000;

export function parseConnectionTarget(raw: string): ConnectionTarget | null {
  const value = raw.trim();

  if (value.length === 0) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Multi-host strings (mongodb://a,b/…) and non-URI formats can't be probed.
    return null;
  }

  const scheme = url.protocol.replace(/:$/, "");
  const baseScheme = scheme.replace(/\+srv$/, "");
  const host = url.hostname;

  if (host.length === 0) {
    return null;
  }

  return {
    scheme,
    baseScheme,
    host,
    port: url.port ? Number(url.port) : null,
    isSrv: scheme.endsWith("+srv")
  };
}

export interface ResolvedEndpoint {
  host: string;
  port: number;
}

type SrvResolver = (hostname: string) => Promise<{ name: string; port: number }[]>;

/**
 * Turns a parsed target into a concrete host:port to connect to. For `+srv`
 * schemes this performs the MongoDB SRV lookup (`_mongodb._tcp.<host>`) and
 * takes the first record. Throws with a human-readable message on failure.
 */
export async function resolveEndpoint(
  target: ConnectionTarget,
  resolveSrv: SrvResolver = dnsResolveSrv
): Promise<ResolvedEndpoint> {
  if (target.isSrv) {
    const records = await resolveSrv(`_mongodb._tcp.${target.host}`);
    if (!records || records.length === 0) {
      throw new Error(`no SRV records for ${target.host}`);
    }
    return { host: records[0].name, port: records[0].port };
  }

  const port = target.port ?? DEFAULT_PORTS[target.baseScheme];
  if (!port) {
    throw new Error(`no port in the connection string and no default for ${target.baseScheme}`);
  }

  return { host: target.host, port };
}

type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<void>;

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export interface ConnectionTestResult {
  reachable: boolean;
  message: string;
}

export interface ConnectionTestDeps {
  resolveSrv?: SrvResolver;
  probe?: TcpProbe;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function testConnection(
  raw: string,
  deps: ConnectionTestDeps = {}
): Promise<ConnectionTestResult> {
  const resolveSrv = deps.resolveSrv ?? dnsResolveSrv;
  const probe = deps.probe ?? tcpProbe;

  const target = parseConnectionTarget(raw);

  if (!target) {
    return {
      reachable: false,
      message:
        "Couldn't read a host out of that connection string. Check that it starts with something like mongodb+srv://…"
    };
  }

  let endpoint: ResolvedEndpoint;
  try {
    endpoint = await resolveEndpoint(target, resolveSrv);
  } catch (error) {
    return {
      reachable: false,
      message: `Couldn't resolve the host — ${describeError(error)}.`
    };
  }

  try {
    await probe(endpoint.host, endpoint.port, PROBE_TIMEOUT_MS);
  } catch (error) {
    return {
      reachable: false,
      message: `Couldn't reach ${endpoint.host}:${endpoint.port} — ${describeError(error)}. Check the host and that your firewall / IP allowlist permits this server.`
    };
  }

  return {
    reachable: true,
    message: `Reached ${endpoint.host}:${endpoint.port}. The database is accepting connections (username and password aren't checked here).`
  };
}
