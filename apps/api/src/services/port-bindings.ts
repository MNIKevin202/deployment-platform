import type { StoredAppPublishedPort } from "../port-database.js";

export interface PortBindingSpec {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}

export interface PublishedPortConfig {
  /** Ports to expose on the container, keyed `"<port>/<proto>"`. */
  ExposedPorts: Record<string, Record<string, never>>;
  /** Host bindings for each exposed port. */
  PortBindings: Record<string, Array<{ HostPort: string }>>;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/**
 * Translates an app's published-port records into the Docker HostConfig
 * fields that bind them on the host. An empty list yields empty maps, so an
 * app with no published ports gets exactly the container config it always did.
 *
 * Each entry both exposes the container port and binds it to the matching
 * host port (Docker publishes on all host interfaces by default).
 */
export function buildPublishedPortConfig(
  ports: Array<Pick<StoredAppPublishedPort, "hostPort" | "containerPort" | "protocol">>
): PublishedPortConfig {
  const config: PublishedPortConfig = { ExposedPorts: {}, PortBindings: {} };

  for (const port of ports) {
    const key = `${port.containerPort}/${port.protocol}`;
    config.ExposedPorts[key] = {};
    config.PortBindings[key] = [{ HostPort: String(port.hostPort) }];
  }

  return config;
}
